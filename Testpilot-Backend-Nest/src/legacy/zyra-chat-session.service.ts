import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { isUuid, normalizeJsonArray, toCamel } from "./legacy.service";

type Body = Record<string, any>;
export type ZyraAuthorizeFn = (userId: string | null | undefined, projectId: string) => Promise<string>;

export const ZYRA_CLAIM_STALE_MINUTES = 5;
export const ZYRA_USER_MESSAGE_PROCESSING = "processing";
export const ZYRA_USER_MESSAGE_FAILED = "failed";

/** What the client sees of a message's options: never `context`. */
export function zyraPublicOptions(raw: unknown): Body | null {
  if (!raw || typeof raw !== "object") return null;
  const options = raw as Body;
  return { kind: options.kind, choices: normalizeJsonArray(options.choices), answeredId: options.answeredId ?? null };
}

@Injectable()
export class ZyraChatSessionService {
  constructor(private readonly db: DatabaseService) {}

  async listSessions(projectId: string, userId: string | null | undefined, authorize: ZyraAuthorizeFn) {
    await authorize(userId, projectId);
    const res = await this.db.query(
      `SELECT s.id, s.project_id, s.user_id, s.title, s.created_at, s.updated_at, s.active_plan,
              EXISTS (SELECT 1 FROM zyra_chat_messages m WHERE m.session_id = s.id) AS has_messages
       FROM zyra_chat_sessions s
       WHERE s.project_id = $1 AND s.deleted_at IS NULL
       ORDER BY s.updated_at DESC
       LIMIT 50`,
      [projectId]
    );
    return { list: res.rows.map(toCamel) };
  }

  async getSession(projectId: string, userId: string | null | undefined, sessionId: string, authorize: ZyraAuthorizeFn) {
    await authorize(userId, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Chat session not found" });
    const session = await this.db.query(
      `SELECT id, project_id, user_id, title, created_at, updated_at, active_plan, language,
              (processing_since IS NOT NULL AND processing_since >= now() - interval '${ZYRA_CLAIM_STALE_MINUTES} minutes') AS turn_alive
       FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [sessionId, projectId]
    );
    if (!session.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    const { turn_alive: turnAlive, ...sessionRow } = session.rows[0];
    const messages = await this.db.query(
      `SELECT id, session_id, project_id, user_id, role, content, reasoning_summary, action_type,
              CASE
                WHEN role = 'user' AND status = $3 AND NOT $4::boolean THEN $5
                WHEN status = 'resuming' AND resuming_since < now() - interval '${ZYRA_CLAIM_STALE_MINUTES} minutes' THEN 'timed_out'
                ELSE status
              END AS status,
              testcases, activity, created_at, review_request_id, resume_attempt, trace, options
       FROM zyra_chat_messages
       WHERE session_id = $1 AND project_id = $2
       ORDER BY created_at ASC`,
      [sessionId, projectId, ZYRA_USER_MESSAGE_PROCESSING, Boolean(turnAlive), ZYRA_USER_MESSAGE_FAILED]
    );
    return {
      ...toCamel(sessionRow),
      messages: messages.rows.map((row) => {
        const item = toCamel(row);
        item.testcases = normalizeJsonArray(row.testcases);
        item.activity = normalizeJsonArray(row.activity);
        item.options = zyraPublicOptions(row.options);
        return item;
      })
    };
  }

  async createSession(projectId: string, userId: string | null | undefined, body: Body, authorize: ZyraAuthorizeFn) {
    await authorize(userId, projectId);
    const title = String(body.title || "Zyra chat").trim().slice(0, 240) || "Zyra chat";
    const res = await this.db.query(
      `INSERT INTO zyra_chat_sessions (project_id, user_id, title)
       VALUES ($1,$2,$3)
       RETURNING id, project_id, user_id, title, created_at, updated_at`,
      [projectId, userId || null, title]
    );
    return { ...toCamel(res.rows[0]), messages: [] };
  }

  async renameSession(projectId: string, userId: string | null | undefined, sessionId: string, body: Body, authorize: ZyraAuthorizeFn) {
    await authorize(userId, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Zyra chat session not found" });
    const title = String(body.title ?? "").trim().slice(0, 240);
    if (!title) throw new BadRequestException({ error: "title is required" });
    const res = await this.db.query(
      `UPDATE zyra_chat_sessions SET title = $3, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
       RETURNING id, project_id, user_id, title, created_at, updated_at`,
      [sessionId, projectId, title]
    );
    if (!res.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    return toCamel(res.rows[0]);
  }

  async deleteSession(projectId: string, userId: string | null | undefined, sessionId: string, authorize: ZyraAuthorizeFn) {
    const uid = await authorize(userId, projectId);
    if (!isUuid(sessionId)) throw new NotFoundException({ error: "Zyra chat session not found" });
    const existing = await this.db.query<{ active_plan: { status?: string } | null }>(
      "SELECT active_plan FROM zyra_chat_sessions WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL",
      [sessionId, projectId]
    );
    if (!existing.rows[0]) throw new NotFoundException({ error: "Zyra chat session not found" });
    if (existing.rows[0].active_plan?.status === "running") {
      throw new ConflictException({ error: "Stop the running generation plan before deleting this conversation." });
    }
    await this.db.query(
      "UPDATE zyra_chat_sessions SET deleted_at = now(), deleted_by = $3 WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL",
      [sessionId, projectId, uid]
    );
    return { success: true };
  }
}
