/** Process-lifetime receipts for successful deletes. Session IDs are immutable;
 * keep receipts across renderer remounts and connection switches, never across
 * app restarts (a restored backend must be visible on the next launch).
 */
export class SessionDeletionVisibility {
  private readonly deleted = new Map<string, Set<string>>();

  forScope(
    connectionId: string,
    profile: string,
  ): {
    confirm: (id: string) => void;
    filter: <T extends { id: string }>(rows: T[]) => T[];
    filterSearch: <T extends { sessionId: string }>(rows: T[]) => T[];
  } {
    const key = JSON.stringify([connectionId, profile]);
    const contains = (id: string): boolean =>
      this.deleted.get(key)?.has(id) === true;
    return {
      confirm: (id) => {
        let ids = this.deleted.get(key);
        if (!ids) this.deleted.set(key, (ids = new Set()));
        ids.add(id);
      },
      filter: (rows) => rows.filter((row) => !contains(row.id)),
      filterSearch: (rows) => rows.filter((row) => !contains(row.sessionId)),
    };
  }
}
