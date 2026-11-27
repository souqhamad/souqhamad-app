import { Tabs, usePathname } from "expo-router";
import { createRef, useState, type ComponentRef, type RefObject } from "react";
import { Platform, View } from "react-native";
import { BottomNavigation } from "../../features/navigation/bottom-navigation";
import { HamadBubble } from "../../features/navigation/hamad-bubble";
import { NavigationScene } from "../../features/navigation/scene-blur";
import { useTheme } from "../../ui/theme-context";
export default function TabLayout() {
  const { colors } = useTheme();
  const pathname = usePathname();
  const [targets] = useState<Record<string, RefObject<ComponentRef<typeof View> | null>>>(() => ({
    listings: createRef<ComponentRef<typeof View>>(),
    messages: createRef<ComponentRef<typeof View>>(),
    index: createRef<ComponentRef<typeof View>>(),
    favorites: createRef<ComponentRef<typeof View>>(),
    account: createRef<ComponentRef<typeof View>>(),
  }));
  return <View style={{ flex: 1, direction: "ltr", backgroundColor: colors.background }}>
    <Tabs
      screenLayout={({ children, route }) => <NavigationScene target={targets[route.name]}
        contentTarget={Platform.OS === "android" && route.name === "index"}>{children}</NavigationScene>}
      tabBar={props => <BottomNavigation {...props} blurTarget={targets[props.state.routes[props.state.index].name]} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background }, tabBarStyle: { position: "absolute" } }}
    >
      <Tabs.Screen name="listings" options={{ title: "إعلاناتي" }} />
      <Tabs.Screen name="messages" options={{ title: "محادثاتي" }} />
      <Tabs.Screen name="index" options={{ title: "الرئيسية" }} />
      <Tabs.Screen name="favorites" options={{ title: "المفضلة" }} />
      <Tabs.Screen name="account" options={{ title: "حسابي" }} />
    </Tabs>
    <HamadBubble visible={pathname === "/"} />
  </View>;
}
