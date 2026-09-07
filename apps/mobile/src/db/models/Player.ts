import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class Player extends Model {
  static table = 'players';

  @field('remote_id') remoteId!: string;
  @field('team_id') teamId!: string | undefined; // undefined for guest-only identities
  @field('first_name') firstName!: string;
  @field('last_name') lastName!: string;
  @field('jersey_number') jerseyNumber!: number | undefined;
  @field('primary_position') primaryPosition!: string | undefined;
  @field('bats') bats!: string | undefined;
  @field('throws') throws!: string | undefined;
  @field('is_active') isActive!: boolean;
  @field('is_guest_only') isGuestOnly!: boolean;
  @field('synced_at') syncedAt!: number | undefined;

  get fullName() {
    return `${this.firstName} ${this.lastName}`;
  }
}
