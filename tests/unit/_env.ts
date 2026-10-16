/**
 * Unit-test helper: run a block with specific env vars, then restore the
 * previous values exactly (including "was unset"). Keeps tests independent
 * of the developer's .env and of each other.
 */
type EnvPatch = Record<string, string | undefined>;

const env = process.env as Record<string, string | undefined>;

function apply(patch: EnvPatch): EnvPatch {
  const previous: EnvPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = env[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return previous;
}

export function withEnv<T>(patch: EnvPatch, fn: () => T): T {
  const previous = apply(patch);
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.finally(() => apply(previous)) as T;
    }
    apply(previous);
    return out;
  } catch (err) {
    apply(previous);
    throw err;
  }
}

/** Minimal stand-in for NextResponse.cookies — records every set() call. */
export function fakeCookieResponse() {
  const calls: { name: string; value: string; opts: Record<string, unknown> }[] = [];
  return {
    calls,
    cookies: {
      set(name: string, value: string, opts: Record<string, unknown>) {
        calls.push({ name, value, opts });
      },
    },
  };
}
