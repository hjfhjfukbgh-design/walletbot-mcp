import type { Env } from "./env";
import { handleCommand } from "./commands";
import { send, type TgUpdate } from "./telegram";

const USER_PREFIX = "tenant:user:";
const KEY_PREFIX = "tenant:";

/**
 * Each Telegram user receives a KV namespace implemented as a strict key prefix.
 * OAuth client registration and user registry stay global; pending OAuth state,
 * tokens, bot state, history and caches are tenant-scoped.
 */
export function tenantEnv(env: Env, userId: string): Env {
  const prefix = `${KEY_PREFIX}${userId}:`;
  const state = {
    get: (key: string, options?: unknown) => env.STATE.get(key === "oauth:client" ? key : prefix + key, options as never),
    put: async (key: string, value: string, options?: unknown) => {
      await env.STATE.put(key === "oauth:client" ? key : prefix + key, value, options as never);
      if (key.startsWith("oauth:pending:")) {
        const stateId = key.slice("oauth:pending:".length);
        await env.STATE.put(`oauth:tenant:${stateId}`, userId, { expirationTtl: 900 });
      }
    },
    delete: async (key: string) => {
      await env.STATE.delete(key === "oauth:client" ? key : prefix + key);
      if (key.startsWith("oauth:pending:")) {
        await env.STATE.delete(`oauth:tenant:${key.slice("oauth:pending:".length)}`);
      }
    },
    list: async (options?: { prefix?: string; limit?: number; cursor?: string }) => {
      const result = await env.STATE.list({
        ...options,
        prefix: prefix + (options?.prefix ?? ""),
      });
      return {
        ...result,
        keys: result.keys.map((item) => ({ ...item, name: item.name.slice(prefix.length) })),
      };
    },
  };
  return {
    ...env,
    OWNER_CHAT_ID: userId,
    ALERT_CHAT_ID: "",
    STATE: state as unknown as KVNamespace,
  };
}

export async function handleTenantUpdate(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text || msg.chat.type !== "private" || !msg.from?.id) return;
  const userId = String(msg.from.id);
  // Telegram private chat IDs normally equal sender IDs; reject mismatches to prevent routing.
  if (String(msg.chat.id) !== userId) return;
  await env.STATE.put(`${USER_PREFIX}${userId}`, JSON.stringify({ chatId: userId, createdAt: new Date().toISOString() }));
  const scoped = tenantEnv(env, userId);
  let reply: string;
  try {
    reply = await handleCommand(scoped, msg.text);
  } catch (error) {
    reply = `❌ ${(error as Error).message}`;
  }
  await send(env, userId, reply);
}

export async function listTenantIds(env: Env): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: USER_PREFIX, limit: 1000, cursor });
    for (const item of page.keys) ids.push(item.name.slice(USER_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (env.OWNER_CHAT_ID && !ids.includes(env.OWNER_CHAT_ID)) ids.push(env.OWNER_CHAT_ID);
  return ids;
}

export async function handleTenantTick(env: Env, userId: string, tick: (env: Env) => Promise<string[]>): Promise<void> {
  const msgs = await tick(tenantEnv(env, userId));
  if (msgs.length) await send(env, userId, msgs.join("\n"));
}

/** Resolve the Telegram user that initiated a browser-based Walt OAuth flow. */
export async function oauthTenantId(env: Env, stateId: string): Promise<string | null> {
  return stateId ? env.STATE.get(`oauth:tenant:${stateId}`) : null;
}
