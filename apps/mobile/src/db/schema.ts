import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * WatermelonDB schema — the offline SQLite read model on the device.
 * Mirror of the Supabase schema for tables needed during offline play.
 * When adding columns here, also add them to the corresponding Supabase migration
 * and update the sync engine mappings.
 *
 * IMPORTANT: every version bump MUST ship a matching step in ./migrations.ts,
 * otherwise WatermelonDB wipes the local database (and unsynced events) on
 * next launch.
 */
export const schema = appSchema({
  version: 3,
  tables: [
    tableSchema({
      name: 'games',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'season_id', type: 'string' },
        { name: 'team_id', type: 'string' },
        { name: 'opponent_name', type: 'string' },
        { name: 'opponent_team_id', type: 'string', isOptional: true, isIndexed: true },
        { name: 'scheduled_at', type: 'number' },           // Unix ms timestamp
        { name: 'location_type', type: 'string' },
        { name: 'neutral_home_team', type: 'string', isOptional: true },
        { name: 'venue_name', type: 'string', isOptional: true },
        { name: 'status', type: 'string' },
        { name: 'home_score', type: 'number' },
        { name: 'away_score', type: 'number' },
        { name: 'current_inning', type: 'number' },
        { name: 'is_top_of_inning', type: 'boolean' },
        { name: 'outs', type: 'number' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'game_events',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'game_id', type: 'string', isIndexed: true },   // WDB local id
        { name: 'game_remote_id', type: 'string', isIndexed: true },
        { name: 'sequence_number', type: 'number' },
        { name: 'event_type', type: 'string' },
        { name: 'inning', type: 'number' },
        { name: 'is_top_of_inning', type: 'boolean' },
        { name: 'payload', type: 'string' },                 // JSON.stringify'd GameEventPayload
        { name: 'occurred_at', type: 'number' },             // Unix ms timestamp
        { name: 'created_by', type: 'string' },              // auth user id
        { name: 'device_id', type: 'string' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'players',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'team_id', type: 'string', isIndexed: true, isOptional: true }, // NULL for guest-only identities
        { name: 'first_name', type: 'string' },
        { name: 'last_name', type: 'string' },
        { name: 'jersey_number', type: 'number', isOptional: true },
        { name: 'primary_position', type: 'string', isOptional: true },
        { name: 'bats', type: 'string', isOptional: true },
        { name: 'throws', type: 'string', isOptional: true },
        { name: 'is_active', type: 'boolean' },
        { name: 'is_guest_only', type: 'boolean' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'game_lineups',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'game_remote_id', type: 'string', isIndexed: true },   // Supabase game UUID
        { name: 'player_remote_id', type: 'string', isIndexed: true }, // Supabase player UUID
        { name: 'batting_order', type: 'number', isOptional: true },   // null = benched pitcher (DH rule)
        { name: 'starting_position', type: 'string', isOptional: true }, // player_position enum value
        { name: 'is_starter', type: 'boolean' },
        { name: 'is_guest', type: 'boolean' },
        { name: 'guest_display_name', type: 'string', isOptional: true },
        { name: 'count_toward_stats', type: 'boolean' },
        { name: 'updated_at', type: 'number' },                        // Unix ms; drives LWW conflict policy
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'league_players',
      columns: [
        { name: 'league_id', type: 'string', isIndexed: true },
        { name: 'player_remote_id', type: 'string', isIndexed: true },
        { name: 'registered_at', type: 'number' },                     // Unix ms
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'channels',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'team_id', type: 'string', isIndexed: true },
        { name: 'channel_type', type: 'string' },
        { name: 'name', type: 'string', isOptional: true },
        { name: 'description', type: 'string', isOptional: true },
        { name: 'last_message_at', type: 'number', isOptional: true },
        { name: 'can_post', type: 'boolean' },              // Current user's post permission in this channel
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'channel_id', type: 'string', isIndexed: true },
        { name: 'channel_remote_id', type: 'string', isIndexed: true },
        { name: 'sender_id', type: 'string' },
        { name: 'sender_name', type: 'string', isOptional: true },  // Denormalized for offline display
        { name: 'body', type: 'string' },
        { name: 'parent_id', type: 'string', isOptional: true },
        { name: 'is_pinned', type: 'boolean' },
        { name: 'created_at', type: 'number' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    // The opposing team's players, keyed by opponent_team_id (games carry
    // opponent_team_id). Mirrored so the scorer can name opponent batters at
    // a field with no signal — without these, every opponent plate
    // appearance is anonymous and their stats are unattributable.
    tableSchema({
      name: 'opponent_players',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'opponent_team_id', type: 'string', isIndexed: true },
        { name: 'first_name', type: 'string' },
        { name: 'last_name', type: 'string' },
        { name: 'jersey_number', type: 'string', isOptional: true },
        { name: 'primary_position', type: 'string', isOptional: true },
        { name: 'is_active', type: 'boolean' },
        { name: 'updated_at', type: 'number' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
    // The opponent's batting order for one game. Server-side this table has
    // only created_at — no updated_at — so the sync engine refreshes it per
    // game rather than by timestamp window (see sync-engine pullChanges).
    tableSchema({
      name: 'opponent_game_lineups',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'game_remote_id', type: 'string', isIndexed: true },
        { name: 'opponent_player_remote_id', type: 'string', isIndexed: true },
        { name: 'batting_order', type: 'number', isOptional: true },
        { name: 'starting_position', type: 'string', isOptional: true },
        { name: 'is_starter', type: 'boolean' },
        { name: 'updated_at', type: 'number' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
