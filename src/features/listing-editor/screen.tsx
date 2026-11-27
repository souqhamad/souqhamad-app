import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { SystemAlert as Alert, useFeedback } from "../../ui/feedback";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { api, ApiError, assetUrl, assertApiIdentity, getApiIdentity } from "../../core/api";
import { useAuth } from "../../core/auth";
import { useBootstrap } from "../../core/bootstrap";
import { useListingPublication } from "../../core/listing-publication-context";
import { listingPublicationFieldsMessage } from "../../core/listing-publication-fields";
import { userMessage } from "../../core/errors";
import { syncListingImageCaches } from "../../core/listing-image-cache";
import { ListingImageUploadClient, type ImageUploadStage } from "../../core/listing-image-upload";
import { runImageUploadBatch } from "../../core/image-upload-batch";
import { ListingImageUploadRecovery, mergeRecoveredListingImages, type ImageUploadRecoveryState } from "../../core/listing-image-upload-recovery";
import { pickListingImages, type UploadAsset } from "../../core/media";
import { FormKeyboardScrollView } from "../../ui/form-keyboard-scroll-view";
import type { Listing } from "../../core/types";
import {
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  PageHeader,
  Screen,
} from "../../ui";
import { useCategorySuggestion } from "./use-category-suggestion";
import { buildEditorImages } from "./editor-images";
import { EditorImage } from "./editor-image";
import { ListingNoPhoto } from "../../ui/listing-no-photo";

const conditionLabels: Record<string, string> = {
  new: "جديد",
  like_new: "شبه جديد",
  used: "مستعمل",
  damaged: "يحتاج إصلاح",
};
const listingStatusLabels: Record<Listing["status"], string> = {
  draft: "مسودة",
  pending: "قيد المراجعة",
  published: "منشور",
  paused: "متوقف",
  sold: "تم بيعه",
  rejected: "غير منشور",
  deleted: "محذوف",
};
export type Form = {
  title: string;
  description: string;
  city: string;
  category: string;
  categoryOption: string;
  carModel: string;
  condition: string;
  priceMode: "amount" | "negotiable" | "bid";
  amount: string;
  year: string;
  mileage: string;
};
const blank: Form = {
  title: "",
  description: "",
  city: "",
  category: "",
  categoryOption: "",
  carModel: "",
  condition: "used",
  priceMode: "amount",
  amount: "",
  year: "",
  mileage: "",
};
type Option = { id: string; label: string };
function errorText(error: unknown) {
  return userMessage(error, "تعذّر إكمال الطلب. أعد المحاولة.");
}
function normalizeNumber(value: string) {
  return value
    .replace(/[٠-٩]/g, (char) => String("٠١٢٣٤٥٦٧٨٩".indexOf(char)))
    .replace(/[۰-۹]/g, (char) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(char)))
    .replace(/[٬,\s]/g, "")
    .replace("٫", ".");
}

export function buildListingBody(
  form: Form,
  listing: Pick<Listing, "category" | "attributes"> | null,
) {
  // The repository merges attributes, so omission retains a previous value.
  // Null explicitly clears visible fields and attributes from another category.
  const clearedPrevious =
    listing && listing.category !== form.category
      ? Object.fromEntries(
          Object.keys(listing.attributes).map((key) => [key, null]),
        )
      : {};
  return {
    title: form.title.trim() || undefined,
    description: form.description.trim() || (listing ? null : undefined),
    city: form.city.trim() || (listing ? null : undefined),
    category: form.category || undefined,
    condition: form.condition,
    price:
      form.priceMode === "amount"
        ? form.amount.trim()
          ? Number(normalizeNumber(form.amount))
          : listing ? null : undefined
        : form.priceMode,
    attributes: {
      ...clearedPrevious,
      marketplaceCategoryOption: form.categoryOption || null,
      marketplaceCarModel:
        form.category === "cars" ? form.carModel || null : null,
      year:
        form.category === "cars" && form.year.trim()
          ? Number(normalizeNumber(form.year))
          : null,
      mileage:
        form.category === "cars" && form.mileage.trim()
          ? Number(normalizeNumber(form.mileage))
          : null,
      saleTerms: null,
    },
  };
}

function mergeListingImageSnapshots(current: Listing, fresh: Listing): Listing {
  if (current.id !== fresh.id) return fresh;
  const images = new Map(fresh.images.map(image => [image.id, image]));
  for (const image of current.images) if (!images.has(image.id)) images.set(image.id, image);
  return { ...fresh, images: [...images.values()] };
}

function SelectField({
  title,
  value,
  options,
  onSelect,
  hint,
}: {
  title: string;
  value: string;
  options: Option[];
  onSelect: (id: string) => void;
  hint?: string;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <>
      <View style={s.selectionLabel}>
        <AppText variant="label">{title}</AppText>
        {hint ? <AppText variant="caption" color={colors.primary} accessibilityLiveRegion="polite">{hint}</AppText> : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => {
          setSearch("");
          setOpen(true);
        }}
        style={s.select}
      >
        <AppText color={value ? colors.text : colors.muted}>
          {options.find((item) => item.id === value)?.label || `اختر ${title}`}
        </AppText>
        <Icon name="chevron-down" size={18} color={colors.muted} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={s.overlay}>
          <View style={s.sheet}>
            <View style={s.between}>
              <AppText variant="heading">{title}</AppText>
              <Button
                title="إغلاق"
                variant="ghost"
                onPress={() => setOpen(false)}
              />
            </View>
            <Field
              placeholder="ابحث في القائمة"
              value={search}
              onChangeText={setSearch}
            />
            <ScrollView keyboardShouldPersistTaps="handled">
              {options
                .filter((item) => item.label.includes(search))
                .map((item) => (
                  <Pressable
                    key={item.id}
                    style={s.option}
                    onPress={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                  >
                    <AppText color={item.id === value ? colors.primary : colors.text}>
                      {item.label}
                    </AppText>
                    {item.id === value && (
                      <Icon
                        name="checkmark-circle"
                        color={colors.primary}
                        size={22}
                      />
                    )}
                  </Pressable>
                ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

export function ListingEditorScreen({ listingId }: { listingId?: string }) {
  const { user, status } = useAuth();
  if (status === "loading")
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  if (!user)
    return (
      <Screen>
        <PageHeader title="إنشاء إعلان" back />
        <EmptyState
          title="سجّل الدخول لإنشاء إعلانك"
          message="احفظ مسودتك وأضف الصور ثم انشر عندما تكون جاهزًا."
          icon="person-outline"
          action={
            <Button title="تسجيل الدخول" onPress={() => router.push("/auth")} />
          }
        />
      </Screen>
    );
  return (
    <Editor
      key={`${user.id}:${listingId ?? "new"}`}
      listingId={listingId}
      ownerId={user.id}
    />
  );
}

function Editor({
  listingId,
  ownerId,
}: {
  listingId?: string;
  ownerId: string;
}) {
  const feedback = useFeedback();
  const { colors } = useTheme();
  const s = useStyles();
  const bootstrap = useBootstrap();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const { coordinator } = useListingPublication();
  const [form, setForm] = useState<Form>(blank);
  const [categorySuggestionEnabled, setCategorySuggestionEnabled] = useState(true);
  const [listing, setListing] = useState<Listing | null>(null);
  const showPublicationActions = (!listingId && !listing) || listing?.status === "draft" || listing?.status === "pending";
  const [assets, setAssets] = useState<UploadAsset[]>([]);
  const [localImagePreviews, setLocalImagePreviews] = useState(() => new Map<string, string>());
  const assetsRef = useRef(assets);
  useEffect(() => { assetsRef.current = assets; }, [assets]);
  const [picking, setPicking] = useState(false);
  const [uploadStages, setUploadStages] = useState<Record<string, ImageUploadStage>>({});
  const [preview, setPreview] = useState(false);
  const createKey = useRef(Crypto.randomUUID());
  const imageDraftCreationAttempted = useRef(false);
  const uploadKeys = useRef(new Map<string, string>());
  const imageRevision = useRef(0);
  const imageActions = useRef<Promise<void>>(Promise.resolve());
  const imageActionsPending = useRef(0);
  const [imageUploads] = useState(() => new ListingImageUploadClient());
  const [recoveredImages, setRecoveredImages] = useState<ImageUploadRecoveryState>({ loading: false, uploads: [], cancelling: [], error: null });
  const imageRecovery = useRef<ListingImageUploadRecovery | null>(null);
  const [imageRecoveryEpoch, setImageRecoveryEpoch] = useState(0);
  const [imageMutationBusy, setImageMutationBusy] = useState(false);
  const [backgroundUploadRequested, setBackgroundUploadRequested] = useState(false);
  const [backgroundUploadBusy, setBackgroundUploadBusy] = useState(false);
  const backgroundUploadRunning = useRef(false);
  const visibleRecoveredImages = recoveredImages.uploads.filter(upload =>
    !assets.some(asset => imageUploads.getUploadId(asset.uri) === upload.id));
  const alive = useRef(true);
  const hydrated = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      imageUploads.cancelAll();
    };
  }, [imageUploads]);
  const ownedQuery = useQuery({
    queryKey: ["owned-listing", ownerId, listingId],
    queryFn: () =>
      api.get<{ listing: Listing }>(
        `/api/marketplace/me/listings/${listingId}`,
      ),
    enabled: Boolean(listingId),
  });
  useEffect(() => {
    if (!ownedQuery.data?.listing || hydrated.current) return;
    hydrated.current = true;
    const value = ownedQuery.data.listing;
    setListing(value);
    const attributes = value.attributes ?? {};
    setForm({
      title: value.title || "",
      description: value.description || "",
      city: value.city || "",
      category: value.category,
      categoryOption: String(attributes.marketplaceCategoryOption || ""),
      carModel: String(attributes.marketplaceCarModel || ""),
      condition: value.condition || "used",
      priceMode:
        typeof value.price === "number" || value.price == null
          ? "amount"
          : value.price,
      amount: typeof value.price === "number" ? String(value.price) : "",
      year: String(attributes.year || ""),
      mileage: String(attributes.mileage || ""),
    });
  }, [ownedQuery.data]);
  const imageUploadProtocol = bootstrap.data?.imageUploads?.protocol;
  const directUploadsEnabled = bootstrap.data?.imageUploads?.enabled;
  // Newly created drafts stay on the new-editor route; follow their saved ID.
  const recoveryListingId = listing?.id || listingId;
  const canRecoverImages = Boolean(listing?.id);
  useEffect(() => {
    if (!focused || imageMutationBusy || backgroundUploadBusy || !recoveryListingId || !canRecoverImages || imageUploadProtocol !== "r2-direct-v1") return;
    const recovery = new ListingImageUploadRecovery({
      listingId: recoveryListingId,
      capability: { protocol: imageUploadProtocol, enabled: directUploadsEnabled === true },
      localUploadIds: () => imageUploads.getActiveUploadIds(),
      imageRevision: () => imageRevision.current,
      onState: state => { if (alive.current) setRecoveredImages(state); },
      onImages: fresh => {
        if (!alive.current) return;
        setListing(current => mergeRecoveredListingImages(current, fresh));
        const readyIds = new Set(fresh.images.map(image => image.id));
        const previews = assetsRef.current.flatMap(asset => {
          const id = imageUploads.getUploadId(asset.uri);
          return id && readyIds.has(id) ? [[id, asset.uri] as const] : [];
        });
        if (previews.length) setLocalImagePreviews(current => new Map([...current, ...previews]));
        setAssets(current => current.filter(asset => !readyIds.has(imageUploads.getUploadId(asset.uri) ?? "")));
        setUploadStages(current => Object.fromEntries(Object.entries(current).filter(([uri]) => !readyIds.has(imageUploads.getUploadId(uri) ?? ""))));
        syncListingImageCaches(queryClient, fresh);
      },
    });
    imageRecovery.current = recovery;
    recovery.start();
    return () => { recovery.stop(); if (imageRecovery.current === recovery) imageRecovery.current = null; };
  }, [focused, recoveryListingId, canRecoverImages, imageUploadProtocol, directUploadsEnabled, imageUploads, queryClient, imageRecoveryEpoch, imageMutationBusy, backgroundUploadBusy]);
  const categorySuggestion = useCategorySuggestion({
    ownerId,
    title: form.title,
    enabled: focused && !listingId && showPublicationActions && categorySuggestionEnabled,
    categories: bootstrap.data?.categories,
    onSuggestion: (suggestion, scope) => setForm(current => {
      if (scope.ownerId !== ownerId || current.title.trim() !== scope.title) return current;
      return {
        ...current,
        ...suggestion,
        ...(current.category !== suggestion.category ? { year: "", mileage: "" } : {}),
      };
    }),
  });
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    if (key === "title") categorySuggestion.cancel();
    setForm((current) => ({ ...current, [key]: value }));
  };
  const maxImages = Math.min(8, bootstrap.data?.limits.maxListingImages ?? 8);
  const maxImageMiB = Math.min(12, (bootstrap.data?.limits.maxImageBytes ?? 12 * 1024 * 1024) / (1024 * 1024));
  const category = bootstrap.data?.categories.find(
    (item) => item.id === form.category,
  );
  const categoryOptions = category?.options ?? [];
  const carModels = category?.carModels?.[form.categoryOption] ?? [];
  const body = () => buildListingBody(form, listing);
  const validate = (forPublication = false) => {
    const data = body();
    if (forPublication) {
      const message = listingPublicationFieldsMessage(data);
      if (message) throw new Error(message);
    }
    if ((!showPublicationActions || data.title) && (data.title?.length ?? 0) < 2)
      throw new Error("أضف عنوانًا واضحًا من حرفين على الأقل.");
    if (!showPublicationActions && !data.category) throw new Error("اختر تصنيف الإعلان.");
    if (data.description && data.description.length < 2)
      throw new Error("اكتب وصفًا من حرفين على الأقل.");
    if (data.city && data.city.length < 2) throw new Error("اختر المدينة.");
    if (typeof data.price === "number" && (!Number.isFinite(data.price) || data.price < 0))
      throw new Error("أدخل سعرًا صحيحًا أو اختر قابل للتفاوض أو على السوم.");
    if (
      form.category === "cars" &&
      form.year &&
      (!/^\d{4}$/.test(normalizeNumber(form.year)) ||
        Number(normalizeNumber(form.year)) < 1900 ||
        Number(normalizeNumber(form.year)) > 2099)
    )
      throw new Error("أدخل سنة صحيحة بين 1900 و2099.");
    if (
      form.category === "cars" &&
      form.mileage &&
      !/^\d+$/.test(normalizeNumber(form.mileage))
    )
      throw new Error("أدخل المسافة بالكيلومتر كرقم صحيح.");
  };
  const save = useMutation({
    mutationFn: async (_forPublication: boolean) => {
      if (backgroundUploadRunning.current || backgroundUploadBusy || imagePreparationPending)
        throw new Error("انتظر اكتمال تجهيز الصور قبل الحفظ.");
      if (imageActionsPending.current) throw new Error("انتظر اكتمال تعديل الصور.");
      validate();
      setImageMutationBusy(true);
      imageRecovery.current?.stop();
      imageRecovery.current = null;
      imageRevision.current++;
      categorySuggestion.cancel();
      const data = body();
      const recoveringPhotoDraft = !listing && imageDraftCreationAttempted.current;
      const identity = recoveringPhotoDraft ? getApiIdentity() : undefined;
      const response = listing
        ? await api.patch<{ listing: Listing }>(`/api/marketplace/listings/${listing.id}`, data)
        : await api.post<{ listing: Listing }>(
            "/api/marketplace/listings",
            recoveringPhotoDraft ? {} : data,
            { idempotencyKey: createKey.current, expectedIdentity: identity },
          );
      let saved = response.listing;
      if (alive.current && recoveringPhotoDraft) {
        // A previous photo draft request can commit even if its response is lost.
        if (saved.sellerId !== ownerId || saved.status !== "draft")
          throw new Error("تعذّر تجهيز مسودة الإعلان لهذا الحساب.");
        setListing(saved);
        saved = (await api.patch<{ listing: Listing }>(
          `/api/marketplace/listings/${saved.id}`, data, { expectedIdentity: identity },
        )).listing;
      }
      if (!alive.current)
        throw new Error("توقفت العملية بعد مغادرة شاشة الإعلان.");
      imageRevision.current++;
      setListing(saved);
      const completed = new Set<string>();
      const hadImages = saved.images.length > 0;
      let failure: unknown;
      try {
        await runImageUploadBatch(assets, async (asset, _index, transferred) => {
          const uploadKey = uploadKeys.current.get(asset.uri) ?? Crypto.randomUUID();
          uploadKeys.current.set(asset.uri, uploadKey);
          const result = await imageUploads.uploadListingImage(saved.id, asset, {
            idempotencyKey: uploadKey, capability: bootstrap.data?.imageUploads,
            onTransferred: transferred,
            onStage: stage => { if (alive.current) setUploadStages(current => ({ ...current, [asset.uri]: stage })); },
          });
          if (!alive.current) throw new Error("توقفت العملية بعد مغادرة شاشة الإعلان.");
          const imageId = imageUploads.getUploadId(asset.uri) ??
            result.listing?.images.find(image => !saved.images.some(existing => existing.id === image.id))?.id;
          if (imageId) setLocalImagePreviews(current => new Map(current).set(imageId, asset.uri));
          completed.add(asset.uri);
          // Never replace a more complete concurrent response with an older one.
          if (result.listing && result.listing.images.length >= saved.images.length) saved = result.listing;
          imageRevision.current++;
          setListing(saved);
          syncListingImageCaches(queryClient, saved);
          setAssets(current => current.filter(item => !completed.has(item.uri)));
          setUploadStages(current => Object.fromEntries(Object.entries(current).filter(([uri]) => !completed.has(uri))));
        }, bootstrap.data?.imageUploads?.enabled ? 2 : 1);
      } catch (error) { failure = error; }
      if (!alive.current) throw failure ?? new Error("توقفت العملية بعد مغادرة شاشة الإعلان.");
      try {
        const first = assets.find(asset => completed.has(asset.uri));
        const primaryId = first ? imageUploads.getUploadId?.(first.uri) : undefined;
        if (!hadImages && primaryId && !saved.images.find(image => image.id === primaryId)?.isPrimary) {
          const primary = await api.patch<{ listing: Listing }>(
            `/api/marketplace/listings/${saved.id}/images/${primaryId}`, { action: "set_primary" },
          );
          saved = primary.listing;
        }
        const fresh = await api.get<{ listing: Listing }>(`/api/marketplace/me/listings/${saved.id}`);
        saved = fresh.listing;
      } catch (error) { failure ??= error; }
      if (alive.current) {
        imageRevision.current++;
        setListing(saved);
        syncListingImageCaches(queryClient, saved);
        setAssets(current => current.filter(asset => !completed.has(asset.uri)));
        setUploadStages(current => Object.fromEntries(Object.entries(current).filter(([uri]) => !completed.has(uri))));
      }
      if (failure) throw failure;
      return saved;
    },
    onSuccess: (result, forPublication) => {
      if (!alive.current) return;
      if (!forPublication) feedback.success(showPublicationActions
        ? result.images.length ? "تم حفظ الإعلان والصور" : "تم حفظ الإعلان"
        : "تم حفظ التعديلات");
      syncListingImageCaches(queryClient, result);
    },
    onSettled: (_data, error, forPublication) => {
      // Publication owns the next phase after a successful save. Recovery may
      // resume only after that phase, or after a failed/local-only save.
      if (forPublication && !error) return;
      if (alive.current) {
        setImageMutationBusy(false);
        setImageRecoveryEpoch(current => current + 1);
      }
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (backgroundUploadRunning.current || backgroundUploadBusy || imagePreparationPending)
        throw new Error("انتظر اكتمال تجهيز الصور قبل النشر.");
      if (imageActionsPending.current) throw new Error("انتظر اكتمال تعديل الصور.");
      validate(true);
      if (recoveredImages.uploads.length || recoveredImages.loading)
        throw new Error("انتظر تجهيز الصور أو ألغِ الصور المنتظرة قبل النشر.");
      if (recoveredImages.error) throw new Error("تحقّق من الصور المنتظرة وأعد المحاولة قبل النشر.");
      categorySuggestion.cancel();
      return coordinator.enqueue({ id: createKey.current, ownerId, listing,
        body: body(), assets, uploadKeys: uploadKeys.current });
    },
    onSuccess: () => {
      if (!alive.current) return;
      setPreview(false);
      // The application owns the submitted snapshot and transfers from here.
      // Leaving this editor only cancels its own unsent/manual-save work.
      router.replace("/(tabs)/listings");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "image_uploads_pending") imageRecovery.current?.retry();
      if (alive.current) feedback.error(error, "تعذّر نشر الإعلان. أعد المحاولة.");
    },
    onSettled: () => {
      if (alive.current) {
        setImageMutationBusy(false);
        setImageRecoveryEpoch(current => current + 1);
      }
    },
  });
  useEffect(() => {
    if (!backgroundUploadRequested) return;
    if (!assets.length) return;
    // Images need a listing ID. Reserve an unpublished draft as soon as
    // the first photo is ready, independently of the form fields.
    if (!showPublicationActions || (listingId && !listing) || imageMutationBusy || save.isPending || publish.isPending || backgroundUploadRunning.current) return;

    backgroundUploadRunning.current = true;
    setBackgroundUploadBusy(true);
    const identity = getApiIdentity();
    void (async () => {
      let saved = listing;
      const completed = new Map<string, string>();
      let failure: unknown;
      try {
        assertApiIdentity(identity);
        if (!saved && !listingId) {
          imageDraftCreationAttempted.current = true;
          const response = await api.post<{ listing: Listing }>("/api/marketplace/listings", {}, {
            idempotencyKey: createKey.current, expectedIdentity: identity,
          });
          assertApiIdentity(identity);
          if (response.listing.sellerId !== ownerId || response.listing.status !== "draft")
            throw new Error("تعذّر تجهيز مسودة الإعلان لهذا الحساب.");
          saved = response.listing;
          imageRevision.current++;
          if (alive.current) setListing(saved);
        }
        if (!saved) return;
        if (saved.sellerId !== ownerId || !["draft", "pending"].includes(saved.status))
          throw new Error("الإعلان غير متاح لتجهيز الصور.");

        const hadImages = saved.images.length > 0;
        try {
          await runImageUploadBatch(assets, async (asset, _index, transferred) => {
            const uploadKey = uploadKeys.current.get(asset.uri) ?? Crypto.randomUUID();
            uploadKeys.current.set(asset.uri, uploadKey);
            const result = await imageUploads.uploadListingImage(saved!.id, asset, {
              idempotencyKey: uploadKey,
              capability: bootstrap.data?.imageUploads,
              onTransferred: transferred,
              onStage: stage => { if (alive.current) setUploadStages(current => ({ ...current, [asset.uri]: stage })); },
            });
            assertApiIdentity(identity);
            const imageId = imageUploads.getUploadId(asset.uri) ??
              result.listing?.images.find(image => !saved!.images.some(existing => existing.id === image.id))?.id;
            if (!result.listing || result.listing.id !== saved!.id || !imageId ||
              !result.listing.images.some(image => image.id === imageId))
              throw new Error("لم يكتمل ربط الصورة بمسودة الإعلان.");
            completed.set(asset.uri, imageId);
            setLocalImagePreviews(current => new Map(current).set(imageId, asset.uri));
            saved = mergeListingImageSnapshots(saved!, result.listing);
            imageRevision.current++;
            if (alive.current) setListing(saved);
          }, bootstrap.data?.imageUploads?.enabled ? 2 : 1);
        } catch (error) {
          failure = error;
        }

        if (!alive.current) return;
        try {
          const first = assets.find(asset => completed.has(asset.uri));
          const primaryId = first ? completed.get(first.uri) : undefined;
          if (!hadImages && primaryId && !saved!.images.find(image => image.id === primaryId)?.isPrimary) {
            const primary = await api.patch<{ listing: Listing }>(
              `/api/marketplace/listings/${saved!.id}/images/${encodeURIComponent(primaryId)}`,
              { action: "set_primary" }, { expectedIdentity: identity },
            );
            assertApiIdentity(identity);
            saved = mergeListingImageSnapshots(saved!, primary.listing);
          }
          const fresh = await api.get<{ listing: Listing }>(
            `/api/marketplace/me/listings/${encodeURIComponent(saved!.id)}`,
            undefined, { expectedIdentity: identity },
          );
          assertApiIdentity(identity);
          saved = fresh.listing;
          if ([...completed.values()].some(id => !saved!.images.some(image => image.id === id)))
            failure ??= new Error("لم يؤكد الخادم حفظ جميع الصور في الإعلان.");
        } catch (error) {
          failure ??= error;
        }

        if (alive.current && saved) {
          const readyIds = new Set(saved.images.map(image => image.id));
          const attached = new Set([...completed].filter(([, imageId]) => readyIds.has(imageId)).map(([uri]) => uri));
          setListing(saved);
          setAssets(current => current.filter(asset => !attached.has(asset.uri)));
          setUploadStages(current => Object.fromEntries(Object.entries(current).filter(([uri]) => !attached.has(uri))));
          imageRevision.current++;
          syncListingImageCaches(queryClient, saved);
        }
        if (failure) throw failure;
      } catch (error) {
        if (alive.current) {
          setBackgroundUploadRequested(false);
          feedback.error(error, "تعذّر تجهيز الصور الآن. بقيت الصور محفوظة لتعيد المحاولة عند الحفظ.");
        }
      } finally {
        backgroundUploadRunning.current = false;
        if (alive.current) setBackgroundUploadBusy(false);
      }
    })();
  }, [backgroundUploadRequested, assets, backgroundUploadBusy, listingId, listing, showPublicationActions,
    imageMutationBusy, save.isPending, publish.isPending, ownerId, imageUploads, bootstrap.data?.imageUploads,
    queryClient, feedback]);
  const busy = save.isPending || publish.isPending || imageMutationBusy;
  const photoBusy = busy || backgroundUploadBusy;
  const imagePreparationPending = showPublicationActions && backgroundUploadRequested && (picking || assets.length > 0);
  const chooseImages = async (source: "camera" | "library") => {
    setPicking(true);
    if (showPublicationActions) setBackgroundUploadRequested(true);
    try {
      const slots = maxImages - (listing?.images.length ?? 0) - assets.length - visibleRecoveredImages.length;
      const selected = await pickListingImages(
        source,
        slots,
        false,
        prepared => {
          if (!alive.current) return;
          setAssets(current => [...current, prepared].slice(0, slots + assets.length));
        },
      );
      if (showPublicationActions && selected.length) feedback.info("بدأ تجهيز الصور أثناء إدخال بيانات الإعلان.");
    } catch (error) {
      feedback.error(error, "تعذّر إضافة الصور. أعد المحاولة.");
    } finally {
      if (alive.current) setPicking(false);
    }
  };
  // Serialize complete request/response pairs. A late delete or primary-image
  // response must never replace a newer image list in the editor or its caches.
  const runImageMutation = (operation: () => Promise<{ listing: Listing }>, success: string, failure: string) => {
    if (save.isPending || publish.isPending) return Promise.resolve();
    const identity = getApiIdentity();
    const scope = feedback.capture();
    imageActionsPending.current++;
    imageRevision.current++;
    setImageMutationBusy(true);
    imageRecovery.current?.stop();
    imageRecovery.current = null;
    const pending = imageActions.current.catch(() => {}).then(async () => {
      assertApiIdentity(identity);
      if (!alive.current || !scope.isCurrent()) return;
      const { listing: updated } = await operation();
      assertApiIdentity(identity);
      if (!alive.current || !scope.isCurrent()) return;
      imageRevision.current++;
      const retained = new Set(updated.images.map(image => image.id));
      setLocalImagePreviews(current => new Map([...current].filter(([id]) => retained.has(id))));
      syncListingImageCaches(queryClient, updated);
      setListing(updated);
      feedback.success(success);
    }).catch(error => {
      if (alive.current && scope.isCurrent()) feedback.error(error, failure);
    }).finally(() => {
      imageActionsPending.current--;
      if (alive.current && scope.isCurrent() && !imageActionsPending.current) {
        setImageMutationBusy(false);
        setImageRecoveryEpoch(current => current + 1);
      }
    });
    imageActions.current = pending;
    return pending;
  };
  const removeImage = (imageId: string) =>
    Alert.alert("حذف الصورة", "هل تريد إزالة هذه الصورة من الإعلان؟", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "حذف",
        style: "destructive",
        onPress: () => {
          void runImageMutation(() => api.delete<{ listing: Listing }>(
              `/api/marketplace/listings/${listing!.id}/images/${imageId}`,
            ), "تمت إزالة الصورة من الإعلان", "تعذّر حذف الصورة. أعد المحاولة.");
        },
      },
    ]);
  if (bootstrap.isPending || (listingId && ownedQuery.isPending))
    return (
      <Screen>
        <PageHeader title={listingId ? "تعديل الإعلان" : "إنشاء إعلان"} back />
        <LoadingState />
      </Screen>
    );
  if (bootstrap.isError || ownedQuery.isError)
    return (
      <Screen>
        <PageHeader title="إعلانك" back />
        <EmptyState
          title="تعذر تحميل بيانات الإعلان"
          message={errorText(bootstrap.error || ownedQuery.error)}
          action={
            <Button
              title="إعادة المحاولة"
              onPress={() => {
                void bootstrap.refetch();
                void ownedQuery.refetch();
              }}
            />
          }
        />
      </Screen>
    );
  const images = buildEditorImages(listing?.images ?? [], assets, localImagePreviews,
    uri => imageUploads.getUploadId(uri) ?? [...localImagePreviews].find(([, local]) => local === uri)?.[0], assetUrl);
  const previewHasNoPhotos = images.length === 0 && (!listingId && !listing || Array.isArray(listing?.images)) &&
    !photoBusy && !picking && !imagePreparationPending &&
    !recoveredImages.loading && !recoveredImages.error && !recoveredImages.uploads.length;
  const previewPhotoStyle = { width: 320, height: 270, borderRadius: 18, marginEnd: 10, backgroundColor: colors.primarySoft };
  const price =
    form.priceMode === "amount"
      ? `${form.amount || "—"} ر.س`
      : form.priceMode === "bid"
        ? "على السوم"
        : "قابل للتفاوض";
  const basicFields = (
    <>
      <Field
        label="عنوان الإعلان"
        placeholder="ما الذي تعرضه للبيع؟"
        value={form.title}
        onChangeText={(value) => set("title", value)}
        maxLength={140}
        editable={!busy}
      />
      {!listingId && showPublicationActions && <Button
        title={categorySuggestionEnabled ? "إيقاف اقتراح التصنيف" : "تفعيل اقتراح التصنيف"}
        variant="ghost"
        icon="sparkles-outline"
        disabled={busy}
        onPress={() => {
          categorySuggestion.cancel();
          setCategorySuggestionEnabled(current => !current);
        }}
      />}
      <SelectField
        title="التصنيف"
        hint={categorySuggestion.status === "pending" ? "جارٍ اقتراح التصنيف…" : categorySuggestion.status === "suggested" ? "مقترح" : undefined}
        value={form.category}
        options={bootstrap.data?.categories ?? []}
        onSelect={(value) => {
          categorySuggestion.lockManualSelection();
          setForm((current) =>
            current.category === value
              ? current
              : {
                  ...current,
                  category: value,
                  categoryOption: "",
                  carModel: "",
                  year: "",
                  mileage: "",
                },
          );
        }}
      />
    </>
  );
  return (
    <Screen scroll={false}>
      <PageHeader
        title={listingId ? "تعديل الإعلان" : "إنشاء إعلان"}
        back
        right={
          <Chip
            label={listing ? listingStatusLabels[listing.status] : "مسودة"}
            active
          />
        }
      />
      <FormKeyboardScrollView contentContainerStyle={s.content}>
        {!listingId && <Card style={s.stack}>
          <AppText variant="heading">التفاصيل الأساسية</AppText>
          {basicFields}
        </Card>}
        <View style={s.between}>
          <AppText variant="heading">صور الإعلان</AppText>
          <AppText variant="caption" color={colors.muted}>
            {images.length + visibleRecoveredImages.length} / {maxImages}
          </AppText>
        </View>
        <ScrollView
          horizontal
          contentContainerStyle={s.photos}
          showsHorizontalScrollIndicator={false}
        >
          {images.map((image, index) => (
            <View key={image.id} style={s.photoBox}>
              <EditorImage sources={image.sources} localUri={image.localUri} style={s.photo}
                active={focused && !preview} accessibilityLabel={`صورة الإعلان ${index + 1}`} />
              {(image.primary || (!listing?.images.length && index === 0)) && (
                <View style={s.photoBadge}>
                  <AppText variant="caption" color={colors.onPrimary}>
                    الرئيسية
                  </AppText>
                </View>
              )}
              <Pressable
                accessibilityLabel="حذف الصورة"
                disabled={photoBusy || picking}
                style={s.remove}
                onPress={() => {
                  if (image.saved) removeImage(image.id);
                  else {
                    imageUploads.cancelAsset(image.uri);
                    setAssets(current => current.filter(item => item.uri !== image.uri));
                    feedback.info("تمت إزالة الصورة المختارة");
                  }
                }}
              >
                <Icon name="close" size={16} color={colors.onPrimary} />
              </Pressable>
              {!image.saved && uploadStages[image.uri] && <View style={s.uploadStage}>
                <AppText variant="caption" color={colors.onPrimary}>{({ preparing: "جارٍ التجهيز", uploading: "جارٍ الرفع", processing: "جارٍ المعالجة", ready: "تمت الإضافة", failed: "تعذّر التجهيز" } as const)[uploadStages[image.uri]]}</AppText>
              </View>}
              {image.saved && !image.primary && (
                <Pressable
                  style={s.makePrimary}
                  disabled={photoBusy || picking}
                  onPress={() => {
                    void runImageMutation(() => api.patch<{ listing: Listing }>(
                        `/api/marketplace/listings/${listing!.id}/images/${image.id}`,
                        { action: "set_primary" },
                      ), "تم تعيين الصورة الرئيسية", "تعذّر تحديث الصورة. أعد المحاولة.");
                  }}
                >
                  <AppText variant="caption" color={colors.primary}>
                    تعيين كرئيسية
                  </AppText>
                </Pressable>
              )}
            </View>
          ))}
          {!images.length && (
            <View style={s.photoEmpty}>
              <Icon name="images-outline" size={32} color={colors.primary} />
              <AppText variant="caption" color={colors.muted}>
                لا توجد صور
              </AppText>
            </View>
          )}
        </ScrollView>
        {visibleRecoveredImages.map(upload => (
          <View key={upload.id} style={s.recoveredImage}>
            <Icon name="image-outline" size={20} color={colors.primary} />
            <AppText variant="caption" style={s.grow}>صورة قيد التجهيز</AppText>
            <Button title="إلغاء" variant="ghost" loading={recoveredImages.cancelling.includes(upload.id)}
              onPress={() => { void imageRecovery.current?.cancel(upload.id); }} />
          </View>
        ))}
        {!!recoveredImages.error && (
          <View style={s.recoveredImage}>
            <AppText variant="caption" style={s.grow}>تعذّر متابعة الصور المنتظرة.</AppText>
            <Button title="إعادة المحاولة" variant="ghost" onPress={() => imageRecovery.current?.retry()} />
          </View>
        )}
        <View style={s.row}>
          <View style={s.grow}>
            <Button
              title="إضافة صور"
              variant="secondary"
              icon="images-outline"
              loading={picking}
              disabled={photoBusy || picking || images.length + visibleRecoveredImages.length >= maxImages}
              onPress={() => void chooseImages("library")}
            />
          </View>
          <View style={s.grow}>
            <Button
              title="التقاط صورة"
              variant="secondary"
              icon="camera-outline"
              disabled={photoBusy || picking || images.length + visibleRecoveredImages.length >= maxImages}
              onPress={() => void chooseImages("camera")}
            />
          </View>
        </View>
        <AppText variant="caption" color={colors.muted}>
          حتى {maxImages} صور، وحتى {new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 1 }).format(maxImageMiB)} ميجابايت للصورة.
        </AppText>
        {backgroundUploadBusy && <AppText variant="caption" color={colors.primary}>
          جارٍ تجهيز الصور ورفعها. يمكنك متابعة إدخال بيانات الإعلان.
        </AppText>}
        <Card style={s.stack}>
          <AppText variant="heading">{listingId ? "التفاصيل الأساسية" : "بيانات الإعلان"}</AppText>
          {listingId && basicFields}
          {!!categoryOptions.length && (
            <SelectField
              title={form.category === "cars" ? "الماركة" : "النوع"}
              value={form.categoryOption}
              options={categoryOptions}
              onSelect={(value) => {
                categorySuggestion.lockManualSelection();
                set("categoryOption", value);
                set("carModel", "");
              }}
            />
          )}
          {!!carModels.length && (
            <SelectField
              title="الموديل"
              value={form.carModel}
              options={carModels}
              onSelect={(value) => {
                categorySuggestion.lockManualSelection();
                set("carModel", value);
              }}
            />
          )}
          <SelectField
            title="المدينة"
            value={form.city}
            options={(bootstrap.data?.cities ?? []).map((city) => ({
              id: city,
              label: city,
            }))}
            onSelect={(value) => set("city", value)}
          />
          <AppText variant="label">الحالة</AppText>
          <View style={s.wrap}>
            {Object.entries(conditionLabels).map(([id, label]) => (
              <Chip
                key={id}
                label={label}
                active={form.condition === id}
                onPress={() => set("condition", id)}
              />
            ))}
          </View>
        </Card>
        {form.category === "cars" && (
          <Card style={s.stack}>
            <AppText variant="heading">تفاصيل المركبة</AppText>
            <Field
              label="سنة الصنع"
              value={form.year}
              keyboardType="number-pad"
              maxLength={4}
              onChangeText={(value) => set("year", value)}
            />
            <Field
              label="المسافة المقطوعة (كم)"
              value={form.mileage}
              keyboardType="number-pad"
              onChangeText={(value) => set("mileage", value)}
            />
          </Card>
        )}
        <Card style={s.stack}>
          <AppText variant="heading">السعر والوصف</AppText>
          <View style={s.wrap}>
            {(
              [
                { id: "amount", label: "سعر محدد" },
                { id: "negotiable", label: "قابل للتفاوض" },
                { id: "bid", label: "على السوم" },
              ] as const
            ).map((item) => (
              <Chip
                key={item.id}
                label={item.label}
                active={form.priceMode === item.id}
                onPress={() => set("priceMode", item.id)}
              />
            ))}
          </View>
          {form.priceMode === "amount" && (
            <Field
              label="السعر بالريال السعودي"
              value={form.amount}
              keyboardType="decimal-pad"
              placeholder="0"
              onChangeText={(value) => set("amount", value)}
              editable={!busy}
            />
          )}
          <Field
            label="وصف الإعلان"
            placeholder="الحالة، المواصفات، الملحقات وأي ملاحظات يهم المشتري معرفتها…"
            value={form.description}
            onChangeText={(value) => set("description", value)}
            maxLength={4000}
            multiline
            numberOfLines={6}
            style={{ minHeight: 145, textAlignVertical: "top" }}
            editable={!busy}
          />
          <AppText variant="caption" color={colors.muted}>
            {form.description.length} / 4000
          </AppText>
        </Card>
        <Card style={s.feeNotice}>
          <Icon name="shield-checkmark-outline" size={22} color={colors.primary} />
          <AppText style={s.grow} variant="caption" color={colors.muted}>
            عند إتمام البيع عبر المنصة تستحق رسوم قدرها 1% من قيمة البيع. راجع
            {showPublicationActions ? " إعلانك وصورك قبل النشر." : " إعلانك وصورك قبل الحفظ."}
          </AppText>
        </Card>
        {showPublicationActions && <Button
          title="معاينة الإعلان"
          icon="eye-outline"
          onPress={() => setPreview(true)}
          disabled={busy || picking}
        />}
        <Button
          title="حفظ التعديلات"
          variant={showPublicationActions ? "secondary" : "primary"}
          icon="save-outline"
          loading={save.isPending && !publish.isPending}
          disabled={photoBusy || picking || imagePreparationPending}
          onPress={() =>
            save.mutate(false, {
              onError: (error) =>
                feedback.error(error, "تعذّر حفظ كل التعديلات. الصور التي لم تُرفع باقية لإعادة المحاولة."),
            })
          }
        />
      </FormKeyboardScrollView>
      {showPublicationActions && <Modal
        visible={preview}
        animationType="slide"
        onRequestClose={() => {
          if (!busy && !picking) setPreview(false);
        }}
      >
        <Screen scroll={false} feedbackModal>
          <PageHeader
            title="معاينة إعلانك"
            subtitle="كما سيظهر للمهتمين"
            right={
              <Button
                title="إغلاق"
                variant="ghost"
                onPress={() => setPreview(false)}
                disabled={busy || picking}
              />
            }
          />
          <ScrollView contentContainerStyle={s.content}>
            <ScrollView horizontal pagingEnabled>
              {previewHasNoPhotos && (
                <View style={[previewPhotoStyle, { overflow: "hidden" }]}>
                  <ListingNoPhoto />
                </View>
              )}
              {images.map((image, index) => (
                <EditorImage
                  key={image.id}
                  sources={image.sources}
                  localUri={image.localUri}
                  active={focused && preview}
                  accessibilityLabel={`معاينة صورة الإعلان ${index + 1}`}
                  style={previewPhotoStyle}
                />
              ))}
            </ScrollView>
            <AppText variant="title">{form.title}</AppText>
            <AppText variant="heading" color={colors.primary}>
              {price}
            </AppText>
            <View style={s.wrap}>
              <Chip label={form.city} />
              <Chip label={category?.label || form.category} />
              <Chip label={conditionLabels[form.condition]} />
            </View>
            <Card>
              <AppText>{form.description}</AppText>
            </Card>
            <AppText variant="caption" color={colors.muted}>
              تخضع الصور والمحتوى لسياسات المنصة. لن يتم النشر حتى تضغط تأكيد
              النشر.
            </AppText>
            <Button
              title="نشر الإعلان"
              icon="paper-plane-outline"
              loading={publish.isPending}
              disabled={busy || picking}
              onPress={() => {
                try {
                  validate(true);
                } catch (error) {
                  setPreview(false);
                  feedback.error(error, "راجع تفاصيل الإعلان قبل النشر.");
                  return;
                }
                if (backgroundUploadRunning.current || imagePreparationPending) {
                  feedback.info("انتظر اكتمال تجهيز الصور قبل النشر.");
                  return;
                }
                Alert.alert(
                  "نشر الإعلان",
                  "تأكدت من صحة البيانات والصور وأرغب في نشر الإعلان. تستحق رسوم المنصة 1% عند إتمام البيع عبرها.",
                  [
                    { text: "مراجعة", style: "cancel" },
                    { text: "تأكيد النشر", onPress: () => publish.mutate() },
                  ],
                );
              }}
            />
          </ScrollView>
        </Screen>
      </Modal>}
    </Screen>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  content: { padding: 12, paddingBottom: 28, gap: 12 },
  stack: { gap: 10 },
  recoveredImage: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: colors.primarySoft },
  selectionLabel: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8 },
  feeNotice: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 10, backgroundColor: colors.primarySoft },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  grow: { flex: 1, minWidth: 0 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  photos: { gap: 12, paddingVertical: 2 },
  photoBox: { width: 122 },
  photo: { width: 122, height: 122, borderRadius: 16, backgroundColor: colors.primarySoft },
  uploadStage: { position: "absolute", bottom: 4, left: 4, right: 4, borderRadius: 6, padding: 3, alignItems: "center", backgroundColor: "#173D35D9" },
  photoBadge: {
    position: "absolute",
    bottom: 26,
    start: 5,
    backgroundColor: colors.primaryFill,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  remove: {
    position: "absolute",
    top: 6,
    end: 6,
    backgroundColor: colors.mediaOverlay,
    borderRadius: 20,
    width: 27,
    height: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  makePrimary: { paddingTop: 5 },
  photoEmpty: {
    width: 300,
    height: 122,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  select: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    minHeight: 52,
    paddingHorizontal: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  overlay: {
    direction: "ltr",
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "85%",
    minHeight: "50%",
    backgroundColor: colors.surface,
    borderTopStartRadius: 26,
    borderTopEndRadius: 26,
    padding: 22,
    gap: 15,
  },
  option: {
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
}));
