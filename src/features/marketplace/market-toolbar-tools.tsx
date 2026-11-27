import { memo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { runOnJS, useAnimatedReaction, type DerivedValue } from "react-native-reanimated";

/** Only this subtree crosses back into React when animated tools become hidden. */
export const MarketToolbarTools = memo(function MarketToolbarTools({ hidden, height, children }: {
  hidden: DerivedValue<boolean>;
  height: number;
  children: ReactNode;
}) {
  const [toolsHidden, setToolsHidden] = useState(false);
  useAnimatedReaction(() => hidden.get(), (value, previous) => {
    if (value !== previous) runOnJS(setToolsHidden)(value);
  });
  return <View
    testID="market-toolbar-tools"
    pointerEvents={toolsHidden ? "none" : "auto"}
    accessibilityElementsHidden={toolsHidden}
    importantForAccessibility={toolsHidden ? "no-hide-descendants" : "auto"}
    style={{ height }}
  >{children}</View>;
});
