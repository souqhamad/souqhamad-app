import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { useFeedback } from "./feedback";

// Keep an account's late mutation callbacks out of the next account's UI.
// The original onMutate context is preserved for the caller's callbacks.
export function useActionMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(options: UseMutationOptions<TData, TError, TVariables, TContext>) {
  const feedback = useFeedback();
  return useMutation({
    ...options,
    onMutate: async (variables, mutationContext) => ({
      scope: feedback.capture(),
      original: await options.onMutate?.(variables, mutationContext),
    }),
    onSuccess: (data, variables, context, mutationContext) => {
      if (context?.scope.isCurrent()) return options.onSuccess?.(data, variables, context.original as TContext, mutationContext);
    },
    onError: (error, variables, context, mutationContext) => {
      if (context?.scope.isCurrent()) return options.onError?.(error, variables, context.original, mutationContext);
    },
    onSettled: (data, error, variables, context, mutationContext) => {
      if (context?.scope.isCurrent()) return options.onSettled?.(data, error, variables, context.original, mutationContext);
    },
  });
}
