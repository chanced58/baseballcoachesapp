import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { getSupabaseClient } from './supabase';

// Configure how notifications are shown when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Requests push notification permissions and registers the Expo push token
 * with Supabase for this user. Called once during app startup.
 */
export async function registerForPushNotifications(): Promise<void> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('Push notification permission not granted');
    return;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  // Minting a push token requires an EAS project. Check before calling rather
  // than catching after: calling without a projectId also logs a deprecation
  // warning on every launch, which buries real warnings in the dev overlay.
  // Local/dev-client builds aren't linked to an EAS project, so this simply
  // skips registration until one is configured.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    console.log('Push registration skipped: no EAS projectId configured');
    return;
  }

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (err) {
    console.warn('Push token request failed; skipping registration', err);
    return;
  }

  // Persist token to Supabase
  const supabase = getSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await supabase.from('push_tokens').upsert(
    {
      user_id: user.id,
      token,
      platform: Platform.OS as 'ios' | 'android',
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
}

let deepLinkSubscription: Notifications.Subscription | null = null;

/**
 * Routes tapped push notifications to the right in-app screen based on the
 * `data.kind` field. Safe to call multiple times — subsequent calls replace
 * the previous listener.
 */
export function setupNotificationDeepLinks(): void {
  deepLinkSubscription?.remove();
  deepLinkSubscription = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = resp.notification.request.content.data as
      | { kind?: string; practiceId?: string; channelId?: string; gameId?: string }
      | undefined;
    if (!data) return;

    if (data.kind === 'pre_practice' && data.practiceId) {
      router.push(`/(tabs)/practices/${data.practiceId}/card` as never);
    }
    if (data.kind === 'message' && data.channelId) {
      router.push({
        pathname: '/(tabs)/messages/[channelId]',
        params: { channelId: data.channelId },
      });
    }
    if (data.kind === 'game' && data.gameId) {
      router.push({
        pathname: '/(tabs)/games/[gameId]/score',
        params: { gameId: data.gameId },
      });
    }
  });
}

