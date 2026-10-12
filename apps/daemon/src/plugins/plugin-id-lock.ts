// One in-process async mutex per plugin id.
//
// Every write to a plugin's install slot (its `installed_plugins` row and its
// folder under the user plugins root) goes through `installFromLocalFolder`
// or `uninstallPlugin`, and both hold this lock for the id while they check
// ownership and replace or remove bytes and the row. So an ownership check
// made inside the lock (`allowReplacePlugin`, `UninstallOptions.onlyIf`)
// still holds when the write happens: HTTP and CLI plugin installs, pack
// content handlers and uninstalls of one id run one at a time. Different ids
// never wait for each other. The lock is not re-entrant.

const tails = new Map<string, Promise<void>>();

/** Wait for the lock on `id`; resolves to its release function (safe to call twice). */
export async function acquirePluginIdLock(id: string): Promise<() => void> {
  const previous = tails.get(id) ?? Promise.resolve();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(id, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    if (tails.get(id) === tail) tails.delete(id);
  };
}

export async function withPluginIdLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  const release = await acquirePluginIdLock(id);
  try {
    return await run();
  } finally {
    release();
  }
}
