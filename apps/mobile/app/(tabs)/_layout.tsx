import { Redirect, Tabs } from 'expo-router';
import { useAuth } from '../../src/providers/AuthProvider';

export default function TabLayout() {
  const { user } = useAuth();

  if (!user) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#1e3a8a',
        tabBarStyle: { borderTopColor: '#e5e7eb' },
        headerStyle: { backgroundColor: '#1e3a8a' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: () => null, tabBarLabel: 'Home' }}
      />
      {/* The Games tab owns a nested Stack (games/_layout.tsx), so its
          detail screens push properly. headerShown is off here because that
          stack draws the header. */}
      <Tabs.Screen
        name="games"
        options={{ title: 'Games', tabBarLabel: 'Games', headerShown: false }}
      />
      <Tabs.Screen
        name="messages/index"
        options={{ title: 'Messages', tabBarLabel: 'Messages' }}
      />

      {/* Reachable from cards on the Home screen, not from the tab bar
          itself — kept out of the bar to keep it to the 3 primary
          destinations (Home, Games, Messages). */}
      <Tabs.Screen name="schedule" options={{ title: 'Schedule', href: null }} />
      <Tabs.Screen name="practices/index" options={{ title: 'Practices', href: null }} />
      <Tabs.Screen name="roster/index" options={{ title: 'Roster', href: null }} />

      {/* Detail/dynamic routes nested under a tab — reachable via push
          navigation, but hidden from the tab bar itself (href: null). The
          games detail routes are not listed: they live inside the Games
          stack. */}
      <Tabs.Screen name="messages/[channelId]" options={{ href: null }} />
      <Tabs.Screen name="practices/[practiceId]/card" options={{ href: null }} />
      <Tabs.Screen name="practices/[practiceId]/attendance" options={{ href: null }} />
    </Tabs>
  );
}
