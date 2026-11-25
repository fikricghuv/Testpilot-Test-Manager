"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { IconBrandTelegram, IconCheck, IconSend, IconTrash } from "@tabler/icons-react";
import { useParams } from "@/lib/routeParams";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { Breadcrumbs, PageHeader } from "@/components/workflows";
import { Button, Card, Field, FieldLabel, Input, PageLoader } from "@/components/ui";
import {
  disconnectTelegramIntegration,
  getTelegramIntegration,
  saveTelegramIntegration,
  testTelegramIntegration,
  type TelegramEventsConfig,
  type TelegramIntegrationStatus,
} from "@/lib/api";

const DEFAULT_EVENTS: TelegramEventsConfig = {
  bugs: true,
  testRuns: true,
  comments: true,
  zyra: true,
  other: true,
};

const EVENT_OPTIONS: Array<{ key: keyof TelegramEventsConfig; label: string; description: string }> = [
  { key: "bugs", label: "Bugs", description: "Bug assigned, reassigned, status changed, and @mentions." },
  { key: "testRuns", label: "Test Runs & Executions", description: "Run started, completed, reopened, failed/blocked cases, and due reminders." },
  { key: "comments", label: "Comments & Replies", description: "Replies on bug or test case discussions." },
  { key: "zyra", label: "Zyra AI & Knowledge Base", description: "Generation ready/failed, reviews, coverage analysis, and document updates." },
  { key: "other", label: "Other Project Updates", description: "Membership changes, requirement updates, and integration sync events." },
];

export default function TelegramProjectIntegrationPage() {
  const params = useParams();
  const projectId = params.id as string;
  const { project } = useProjectData();
  const projectName = typeof project.name === "string" ? project.name : "";

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<TelegramIntegrationStatus | null>(null);

  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<TelegramEventsConfig>(DEFAULT_EVENTS);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTelegramIntegration(projectId)
      .then((res) => {
        if (cancelled) return;
        setStatus(res);
        setChatId(res.chatId ?? "");
        setThreadId(res.threadId != null ? String(res.threadId) : "");
        setEnabled(res.enabled);
        setEvents(res.events ?? DEFAULT_EVENTS);
      })
      .catch((err) => {
        if (!cancelled) {
          setFeedback({
            kind: "error",
            text: err instanceof Error ? err.message : "Failed to load Telegram integration settings.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setSaving(true);
    try {
      const saved = await saveTelegramIntegration(projectId, {
        botToken: botToken.trim() || undefined,
        chatId: chatId.trim(),
        threadId: threadId.trim() ? Number(threadId.trim()) : null,
        enabled,
        events,
      });
      setStatus(saved);
      setBotToken("");
      setFeedback({ kind: "success", text: "Telegram notification settings saved." });
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to save Telegram settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setFeedback(null);
    setTesting(true);
    try {
      await testTelegramIntegration(projectId, {
        botToken: botToken.trim() || undefined,
        chatId: chatId.trim() || undefined,
        threadId: threadId.trim() ? Number(threadId.trim()) : null,
      });
      setFeedback({ kind: "success", text: "Test message sent! Check your Telegram chat." });
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to send test message.",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setFeedback(null);
    setDisconnecting(true);
    try {
      await disconnectTelegramIntegration(projectId);
      setStatus({
        connected: false,
        enabled: true,
        chatId: null,
        threadId: null,
        hasBotToken: false,
        maskedBotToken: null,
        events: DEFAULT_EVENTS,
        updatedAt: null,
      });
      setBotToken("");
      setChatId("");
      setThreadId("");
      setEnabled(true);
      setEvents(DEFAULT_EVENTS);
      setFeedback({ kind: "success", text: "Telegram integration disconnected." });
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to disconnect Telegram integration.",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return <PageLoader variant="content" />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Telegram Notifications"
        subtitle="Forward project notifications directly to a Telegram group, channel, or topic."
        breadcrumb={
          <Breadcrumbs
            items={[
              { label: "Projects", href: "/projects" },
              { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
              { label: "Settings", href: `/projects/${projectId}/settings?tab=integrations` },
              { label: "Telegram" },
            ]}
          />
        }
        actions={
          <Link
            href={`/projects/${projectId}/settings?tab=integrations`}
            className="inline-flex h-9 items-center rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
          >
            Back to Integrations
          </Link>
        }
      />

      <Card className="p-5">
        <div className="mb-5 flex items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#229ED9]">
              <IconBrandTelegram size={20} stroke={1.75} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--foreground)]">Telegram Bot</h2>
              <p className="text-xs text-[var(--muted)]">
                {status?.connected
                  ? status.enabled
                    ? `Active · Chat ${status.chatId}${status.maskedBotToken ? ` · Token ${status.maskedBotToken}` : ""}`
                    : `Paused · Chat ${status.chatId}`
                  : "Not connected yet"}
              </p>
            </div>
          </div>
          {status?.connected && (
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                status.enabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
              }`}
            >
              {status.enabled ? "Connected" : "Paused"}
            </span>
          )}
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          <Field>
            <FieldLabel htmlFor="telegram-bot-token">
              Bot Token {status?.hasBotToken ? "(leave blank to keep saved token)" : "*"}
            </FieldLabel>
            <Input
              id="telegram-bot-token"
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={status?.hasBotToken ? `Saved (${status.maskedBotToken}) — enter new token to replace` : "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-[var(--muted-soft)]">
              Create a bot with <span className="font-mono">@BotFather</span> on Telegram, copy its token, and add the bot to your target group or channel.
            </p>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field>
                <FieldLabel htmlFor="telegram-chat-id">Chat ID *</FieldLabel>
                <Input
                  id="telegram-chat-id"
                  type="text"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="-1001234567890 or @your_channel"
                  required
                />
                <p className="mt-1 text-xs text-[var(--muted-soft)]">
                  Group/supergroup IDs usually start with <span className="font-mono">-100</span>.
                </p>
              </Field>
            </div>
            <div>
              <Field>
                <FieldLabel htmlFor="telegram-thread-id">Topic / Thread ID</FieldLabel>
                <Input
                  id="telegram-thread-id"
                  type="number"
                  min={1}
                  value={threadId}
                  onChange={(e) => setThreadId(e.target.value)}
                  placeholder="Optional"
                />
                <p className="mt-1 text-xs text-[var(--muted-soft)]">For Forum group topics.</p>
              </Field>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-3.5">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-[var(--foreground)]">Enable Telegram notifications</div>
                <div className="text-xs text-[var(--muted)]">Pause delivery anytime without removing your bot configuration.</div>
              </div>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 accent-[var(--brand-primary)]"
              />
            </label>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--muted-soft)]">Events to forward</p>
            <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt.key} className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 hover:bg-[var(--surface-secondary)]/40">
                  <input
                    type="checkbox"
                    checked={events[opt.key]}
                    onChange={(e) => setEvents((prev) => ({ ...prev, [opt.key]: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 accent-[var(--brand-primary)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--foreground)]">{opt.label}</div>
                    <div className="text-xs text-[var(--muted)]">{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {feedback && (
            <div
              className={`rounded-lg border px-3.5 py-2.5 text-sm ${
                feedback.kind === "success"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-[var(--error)]/30 bg-[var(--error-soft)] text-[var(--status-fail-text)]"
              }`}
            >
              {feedback.text}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <div>
              {status?.connected && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={disconnecting || saving || testing}
                >
                  <IconTrash size={15} stroke={1.75} />
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={handleTest}
                disabled={testing || saving || disconnecting || !chatId.trim() || (!botToken.trim() && !status?.hasBotToken)}
              >
                <IconSend size={15} stroke={1.75} />
                {testing ? "Sending…" : "Send Test Message"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={saving || testing || disconnecting || !chatId.trim() || (!botToken.trim() && !status?.hasBotToken)}
              >
                <IconCheck size={15} stroke={1.75} />
                {saving ? "Saving…" : "Save Settings"}
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}
