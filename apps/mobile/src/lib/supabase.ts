import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import type { Database } from '@baseball/database';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Token persistence in SecureStore (Keychain), chunked.
 *
 * A Supabase session — access token, refresh token and the serialized user —
 * runs well past SecureStore's 2048-byte advisory limit, which warns on every
 * write and is not guaranteed to store the value at all. A dropped write means
 * the scorer is silently signed out, so long values are split across numbered
 * keys and reassembled on read rather than trusting a single oversized entry.
 *
 * Values written before this change are plain strings under the bare key; the
 * marker check in getItem keeps reading those, so existing sessions survive.
 */
const CHUNK_SIZE = 1800; // headroom under the 2048-byte limit
const CHUNK_MARKER = '__chunked__:';

const chunkKey = (key: string, i: number) => `${key}.${i}`;

async function clearChunks(key: string): Promise<void> {
  const head = await SecureStore.getItemAsync(key);
  if (head === null || !head.startsWith(CHUNK_MARKER)) return;
  const count = Number(head.slice(CHUNK_MARKER.length)) || 0;
  for (let i = 0; i < count; i += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, i));
  }
}

const ExpoSecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(key);
    if (head === null) return null;
    if (!head.startsWith(CHUNK_MARKER)) return head;

    const count = Number(head.slice(CHUNK_MARKER.length)) || 0;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      // A missing chunk means the stored session is torn; report it absent so
      // the caller re-authenticates instead of parsing a truncated token.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    await clearChunks(key);
    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await SecureStore.setItemAsync(chunkKey(key, i), chunks[i]);
    }
    // Written last so a partial write never leaves a marker pointing at
    // chunks that don't exist yet.
    await SecureStore.setItemAsync(key, `${CHUNK_MARKER}${chunks.length}`);
  },

  async removeItem(key: string): Promise<void> {
    await clearChunks(key);
    await SecureStore.deleteItemAsync(key);
  },
};

let _client: SupabaseClient<Database> | undefined;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (!_client) {
    _client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: ExpoSecureStoreAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  }
  return _client;
}
