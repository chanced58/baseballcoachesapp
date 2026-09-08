import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Q } from '@nozbe/watermelondb';
import { syncWithSupabase } from '../sync/sync-engine';
import { getSupabaseClient } from '../lib/supabase';
import { database } from '../db';
import type { GameEvent } from '../db/models/GameEvent';

interface SyncContextValue {
  isSyncing: boolean;
  lastSyncedAt: number | null;
  /** A genuine sync failure. Losing connectivity is NOT one — see isOffline. */
  lastSyncError: Error | null;
  /** No usable connection. Expected and safe: writes queue locally. */
  isOffline: boolean;
  pendingEventsCount: number;
  triggerSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue>({
  isSyncing: false,
  lastSyncedAt: null,
  lastSyncError: null,
  isOffline: false,
  pendingEventsCount: 0,
  triggerSync: async () => {},
});

/**
 * Was this failure just a missing network, rather than something wrong?
 *
 * Scoring is offline-first: at a field with no signal every sync attempt
 * fails, and that is the design working, not a fault. Treating it as an error
 * puts a red "Sync failed" in front of the scorer mid-game and teaches them to
 * ignore the one indicator that should mean something.
 */
function isConnectivityFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /network request failed|fetch failed|network error|timeout|offline|Failed to fetch/i.test(
    message,
  );
}

export function useSyncContext() {
  return useContext(SyncContext);
}

/**
 * Provides background sync orchestration.
 * - Triggers an initial sync on mount when online (bootstrap — fresh
 *   installs / new devices hydrate immediately instead of waiting for the
 *   30-second interval)
 * - Triggers sync when the app returns to the foreground
 * - Triggers sync when network becomes available (was offline → online)
 * - Triggers sync every 30 seconds when online and a game is in progress
 * - Exposes a manual triggerSync() for use in the scoring screen after each event
 * - Surfaces sync failures and pending-event counts so the UI can alert the
 *   scorer when events have not yet reached Supabase.
 */
export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastSyncError, setLastSyncError] = useState<Error | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [pendingEventsCount, setPendingEventsCount] = useState(0);
  const wasOfflineRef = useRef(false);
  const syncLockRef = useRef(false);

  const triggerSync = async () => {
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    setIsSyncing(true);

    try {
      const supabase = getSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await syncWithSupabase();
      setLastSyncedAt(Date.now());
      setLastSyncError(null);
      setIsOffline(false);
    } catch (error) {
      if (isConnectivityFailure(error)) {
        // Expected while out of signal. Everything stays queued locally and
        // pushes on reconnect, so mark the state, don't raise an error.
        setIsOffline(true);
        setLastSyncError(null);
      } else {
        console.warn('Sync failed:', error);
        setLastSyncError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      setIsSyncing(false);
      syncLockRef.current = false;
    }
  };

  // Observe count of locally-created events not yet acked by Supabase.
  // A non-zero count means either a sync is pending or sync has failed —
  // in either case the scorer should be able to see it.
  //
  // We query WatermelonDB's internal _status field rather than our
  // app-level synced_at column. synced_at is set to null at create time
  // but nothing updates it after a successful push — only the pulled
  // rows in sync-engine's mapGameEvent get synced_at populated. WDB's
  // synchronize() flow, however, always transitions records from
  // _status='created' to _status='synced' after pushChanges returns
  // successfully, so this query accurately reflects "not yet acked
  // by the server."
  useEffect(() => {
    const collection = database.get<GameEvent>('game_events');
    const subscription = collection
      .query(Q.unsafeSqlExpr(`_status != 'synced'`))
      .observeCount()
      .subscribe(setPendingEventsCount);
    return () => subscription.unsubscribe();
  }, []);

  // Bootstrap sync on mount — a cold start that is already online never
  // fires the offline→online listener (wasOfflineRef starts false), so a
  // fresh install / new device would otherwise show empty data for up to
  // 30 seconds. triggerSync itself no-ops when not authenticated.
  useEffect(() => {
    NetInfo.fetch().then((state) => {
      if (state.isConnected && state.isInternetReachable) {
        triggerSync();
      }
    });
  }, []);

  // Sync on sign-in — a fresh login on a new device should hydrate
  // immediately (the mount bootstrap already ran unauthenticated and
  // no-oped).
  useEffect(() => {
    const supabase = getSupabaseClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_IN') return;
      NetInfo.fetch().then((state) => {
        if (state.isConnected && state.isInternetReachable) {
          triggerSync();
        }
      });
    });
    return () => subscription.unsubscribe();
  }, []);

  // Sync when the app returns to the foreground — locking the phone
  // mid-game stops the interval; this catches up as soon as the scorer
  // comes back.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      NetInfo.fetch().then((state) => {
        if (state.isConnected && state.isInternetReachable) {
          triggerSync();
        }
      });
    });
    return () => subscription.remove();
  }, []);

  // Sync when network is restored after being offline
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected && state.isInternetReachable;

      // Reflect connectivity directly, so the scorer sees "offline" the moment
      // signal drops rather than only after a sync attempt has failed.
      setIsOffline(!isConnected);
      if (isConnected) setLastSyncError(null);

      if (wasOfflineRef.current && isConnected) {
        triggerSync();
      }

      wasOfflineRef.current = !isConnected;
    });

    return unsubscribe;
  }, []);

  // Periodic sync every 30 seconds when app is active
  useEffect(() => {
    const interval = setInterval(() => {
      NetInfo.fetch().then((state) => {
        if (state.isConnected && state.isInternetReachable) {
          triggerSync();
        }
      });
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  return (
    <SyncContext.Provider
      value={{ isSyncing, lastSyncedAt, lastSyncError, isOffline, pendingEventsCount, triggerSync }}
    >
      {children}
    </SyncContext.Provider>
  );
}
