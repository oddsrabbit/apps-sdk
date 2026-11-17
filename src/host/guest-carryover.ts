/**
 * Carrying a guest's saves over to their account the first time they play
 * signed in.
 *
 * A guest's `storage.*` is answered by the host from localStorage on this
 * origin (see handleGuestStorageRequest in host.ts); a signed-in player's goes
 * to the server. Without this, signing up from inside a game — the moment the
 * game itself asked for — lands the player on an empty save, and the guest one
 * sits in a namespace the signed-in session never reads.
 *
 * The rule is all or nothing, decided per game:
 *
 * - The account has none of the guest's keys: copy every one, then clear them
 *   here. This is the case that matters — a new account made from a game.
 * - The account already has any of them: copy nothing and leave the guest
 *   saves where they are. Two saves of the same game can't be merged by the
 *   host (it doesn't know what's in them), and overwriting a real account's
 *   progress with a few minutes of guest play is the worse mistake.
 * - Anything fails: undo what was copied (best effort) and keep the guest
 *   saves, so the next signed-in load tries again from a clean account.
 *
 * And it only runs when the guest asked to sign up from that game: the host
 * leaves a timestamped marker when a guest game sends `actions.requestSignIn`
 * (the outer host reloads the game once sign-in succeeds, so it has to be
 * stored), and carries over on a signed-in load only while the marker is
 * fresh. Without that, whoever next signs in on a shared browser (a parent
 * after a child's guest play, days later) would be handed the guest's saves.
 * It also keeps every other signed-in load free of the extra round trip.
 *
 * Pure apart from the injected dependencies, so it is tested without a DOM.
 */

/** How long after a guest taps sign-up their saves may still be carried over. */
export const CARRY_OVER_MARKER_TTL_MS = 60 * 60 * 1000;

/**
 * Where the host keeps a game's sign-up marker. Outside every guest save
 * prefix (`oddsrabbit:apps:<slug>:`), so it's never carried over itself.
 */
export function carryOverMarkerKey(appSlug: string): string {
  return `oddsrabbit:carryover:${appSlug}`;
}

/** True when `raw` (a marker's stored `Date.now()`) is from the last hour. */
export function isFreshCarryOverMarker(raw: string | null, now: number): boolean {
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && at <= now && now - at <= CARRY_OVER_MARKER_TTL_MS;
}

export type CarryOverOutcome = 'none' | 'copied' | 'conflict' | 'failed';

export interface CarryOverDeps {
  /** The guest's saves for this game, as [key, value]. */
  entries: ReadonlyArray<readonly [string, string]>;
  /** The account's value for a key, through the outer host; null when unset. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove a guest save from this origin's localStorage. */
  clearLocal(key: string): void;
}

export async function carryOverGuestSaves(deps: CarryOverDeps): Promise<CarryOverOutcome> {
  const { entries } = deps;
  if (entries.length === 0) return 'none';

  let existing: Array<string | null>;
  try {
    existing = await Promise.all(entries.map(([key]) => deps.get(key)));
  } catch {
    return 'failed';
  }
  if (existing.some((value) => value !== null)) return 'conflict';

  // One at a time: the server checks the game's total size per write, and
  // parallel writes would race that check.
  // Every key a write was sent for, including the one that failed: a write
  // that timed out may still have landed, and left behind it would read as a
  // conflict on every later load, with the account holding part of a save.
  // All of them were confirmed unset above, so deleting them loses nothing.
  const attempted: string[] = [];
  try {
    for (const [key, value] of entries) {
      attempted.push(key);
      await deps.set(key, value);
    }
  } catch {
    // In parallel, unlike the writes: deletes only shrink the game's total, and
    // the game is held until this finishes.
    await Promise.all(attempted.map((key) => deps.delete(key).catch(() => undefined)));
    return 'failed';
  }

  for (const [key] of entries) {
    try {
      deps.clearLocal(key);
    } catch {
      // Storage blocked mid-way: the copy still happened, and the next load
      // sees the account's keys and leaves the remainder alone.
    }
  }
  return 'copied';
}

/**
 * The guest's saves for one game from a Storage, as [key, value] with the
 * namespace stripped. `prefix` is the full `<namespace>:<slug>:` string, colon
 * included, so `rabbit` never picks up `rabbit-words`.
 */
export function readGuestEntries(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
  prefix: string
): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (!name || !name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length);
    const value = storage.getItem(name);
    if (key === '' || value === null) continue;
    found.push([key, value]);
  }
  return found;
}
