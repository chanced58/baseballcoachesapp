import { schemaMigrations, createTable, addColumns } from '@nozbe/watermelondb/Schema/migrations';

/**
 * WatermelonDB schema migrations — REQUIRED companion to schema.ts.
 *
 * Every schema.ts version bump MUST ship a matching migration step here.
 * Without one, WatermelonDB wipes and rebuilds the local database on next
 * launch, destroying any unsynced game_events recorded offline.
 */
export const migrations = schemaMigrations({
  migrations: [
    {
      // v2: offline lineup management — local mirrors of game_lineups and
      // league_players, plus the guest flag on players. players.team_id also
      // became optional in schema.ts (guest identities have no team); that
      // needs no migration step because SQLite columns are nullable underneath.
      toVersion: 2,
      steps: [
        createTable({
          name: 'game_lineups',
          columns: [
            { name: 'remote_id', type: 'string', isIndexed: true },
            { name: 'game_remote_id', type: 'string', isIndexed: true },
            { name: 'player_remote_id', type: 'string', isIndexed: true },
            { name: 'batting_order', type: 'number', isOptional: true },
            { name: 'starting_position', type: 'string', isOptional: true },
            { name: 'is_starter', type: 'boolean' },
            { name: 'is_guest', type: 'boolean' },
            { name: 'guest_display_name', type: 'string', isOptional: true },
            { name: 'count_toward_stats', type: 'boolean' },
            { name: 'updated_at', type: 'number' },
            { name: 'synced_at', type: 'number', isOptional: true },
          ],
        }),
        createTable({
          name: 'league_players',
          columns: [
            { name: 'league_id', type: 'string', isIndexed: true },
            { name: 'player_remote_id', type: 'string', isIndexed: true },
            { name: 'registered_at', type: 'number' },
            { name: 'synced_at', type: 'number', isOptional: true },
          ],
        }),
        addColumns({
          table: 'players',
          columns: [{ name: 'is_guest_only', type: 'boolean' }],
        }),
      ],
    },
    {
      // v3: the opposing side. Local mirrors of opponent_players and
      // opponent_game_lineups so a scorer can name opponent batters, and
      // add them mid-game, with no signal at the field.
      toVersion: 3,
      steps: [
        addColumns({
          table: 'games',
          columns: [{ name: 'opponent_team_id', type: 'string', isOptional: true, isIndexed: true }],
        }),
        createTable({
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
        createTable({
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
    },
  ],
});
