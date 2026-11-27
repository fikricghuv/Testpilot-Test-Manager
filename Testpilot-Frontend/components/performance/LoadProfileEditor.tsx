"use client";

import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { PerformanceLoadProfile, PerformanceStage } from "@/lib/api";
import { Button, Field, FieldLabel, Input, Select } from "@/components/ui";

export interface LoadProfileValue {
  loadProfile: PerformanceLoadProfile;
  vus: number;
  durationSec: number;
  targetRps: number;
  stages: PerformanceStage[];
}

const PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  value: LoadProfileValue;
}> = [
  {
    id: "smoke",
    label: "Smoke",
    description: "3 VUs · 15s",
    value: { loadProfile: "fixed", vus: 3, durationSec: 15, targetRps: 10, stages: [] },
  },
  {
    id: "ramp-load",
    label: "Ramp-Up Load",
    description: "0 → 25 → 0 VUs (40s)",
    value: {
      loadProfile: "ramping",
      vus: 25,
      durationSec: 40,
      targetRps: 10,
      stages: [
        { durationSec: 10, targetVus: 10 },
        { durationSec: 20, targetVus: 25 },
        { durationSec: 10, targetVus: 0 },
      ],
    },
  },
  {
    id: "spike",
    label: "Spike Test",
    description: "Sudden jump to 60 VUs (30s)",
    value: {
      loadProfile: "ramping",
      vus: 60,
      durationSec: 30,
      targetRps: 10,
      stages: [
        { durationSec: 5, targetVus: 5 },
        { durationSec: 5, targetVus: 60 },
        { durationSec: 15, targetVus: 60 },
        { durationSec: 5, targetVus: 0 },
      ],
    },
  },
  {
    id: "stress",
    label: "Stress Test",
    description: "Step up to 80 VUs (60s)",
    value: {
      loadProfile: "ramping",
      vus: 80,
      durationSec: 60,
      targetRps: 10,
      stages: [
        { durationSec: 15, targetVus: 20 },
        { durationSec: 15, targetVus: 50 },
        { durationSec: 15, targetVus: 80 },
        { durationSec: 15, targetVus: 0 },
      ],
    },
  },
  {
    id: "constant-rps",
    label: "Constant RPS",
    description: "20 req/s · 30s",
    value: { loadProfile: "constant-arrival-rate", vus: 20, durationSec: 30, targetRps: 20, stages: [] },
  },
];

function LoadShapePreview({ value }: { value: LoadProfileValue }) {
  const w = 360;
  const h = 64;
  const padX = 8;
  const padY = 8;

  const points: Array<{ t: number; yVal: number }> = [];
  if (value.loadProfile === "ramping" && value.stages.length > 0) {
    let t = 0;
    points.push({ t: 0, yVal: 0 });
    for (const s of value.stages) {
      t += Math.max(1, s.durationSec);
      points.push({ t, yVal: Math.max(0, s.targetVus) });
    }
  } else if (value.loadProfile === "constant-arrival-rate") {
    const dur = Math.max(1, value.durationSec);
    const rps = Math.max(1, value.targetRps);
    points.push({ t: 0, yVal: rps }, { t: dur, yVal: rps });
  } else {
    const dur = Math.max(1, value.durationSec);
    const vus = Math.max(1, value.vus);
    points.push({ t: 0, yVal: vus }, { t: dur, yVal: vus });
  }

  const maxT = Math.max(...points.map((p) => p.t), 1);
  const maxY = Math.max(...points.map((p) => p.yVal), 1);
  const coords = points.map((p) => ({
    x: padX + (p.t / maxT) * (w - padX * 2),
    y: padY + (h - padY * 2) - (p.yVal / maxY) * (h - padY * 2),
  }));

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${(h - padY).toFixed(1)} L${coords[0].x.toFixed(1)},${(h - padY).toFixed(1)} Z`;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span>Load Profile Shape</span>
        <span className="font-mono">
          {value.loadProfile === "constant-arrival-rate"
            ? `${value.targetRps} req/s · ${maxT}s`
            : `Peak ${maxY} VUs · ${maxT}s`}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full">
        <path d={area} fill="var(--brand-primary)" fillOpacity="0.15" />
        <path d={line} fill="none" stroke="var(--brand-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r="2.5" fill="var(--brand-primary)" />
        ))}
      </svg>
    </div>
  );
}

export function LoadProfileEditor({
  value,
  onChange,
}: {
  value: LoadProfileValue;
  onChange: (next: LoadProfileValue) => void;
}) {
  const totalStageSec = value.stages.reduce((acc, s) => acc + (s.durationSec || 0), 0);

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/20 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
          Load Profile Presets
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.description}
              onClick={() => onChange(p.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--brand-primary)] hover:bg-[var(--surface-secondary)]"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel>Profile Type</FieldLabel>
          <Select
            value={value.loadProfile}
            onChange={(e) => {
              const nextProfile = e.target.value as PerformanceLoadProfile;
              const nextStages =
                nextProfile === "ramping" && value.stages.length === 0
                  ? [
                      { durationSec: 10, targetVus: 10 },
                      { durationSec: 15, targetVus: 25 },
                      { durationSec: 5, targetVus: 0 },
                    ]
                  : value.stages;
              onChange({ ...value, loadProfile: nextProfile, stages: nextStages });
            }}
          >
            <option value="fixed">Fixed VUs</option>
            <option value="ramping">Ramping Stages</option>
            <option value="constant-arrival-rate">Constant RPS (Arrival Rate)</option>
          </Select>
        </Field>

        {value.loadProfile === "fixed" ? (
          <>
            <Field>
              <FieldLabel>Virtual Users (1-100)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={100}
                value={value.vus}
                onChange={(e) => onChange({ ...value, vus: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field>
              <FieldLabel>Duration (sec, 1-300)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={300}
                value={value.durationSec}
                onChange={(e) => onChange({ ...value, durationSec: Number(e.target.value) || 1 })}
              />
            </Field>
          </>
        ) : value.loadProfile === "constant-arrival-rate" ? (
          <>
            <Field>
              <FieldLabel>Target RPS (1-500 req/s)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={500}
                value={value.targetRps}
                onChange={(e) => onChange({ ...value, targetRps: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field>
              <FieldLabel>Duration (sec) &amp; Pre-VUs</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="number"
                  min={1}
                  max={300}
                  title="Duration (seconds)"
                  value={value.durationSec}
                  onChange={(e) => onChange({ ...value, durationSec: Number(e.target.value) || 1 })}
                />
                <Input
                  type="number"
                  min={1}
                  max={100}
                  title="Pre-allocated VUs"
                  value={value.vus}
                  onChange={(e) => onChange({ ...value, vus: Number(e.target.value) || 1 })}
                />
              </div>
            </Field>
          </>
        ) : (
          <div className="flex items-end justify-between sm:col-span-2">
            <span className="text-xs text-[var(--muted)]">
              Total stage duration: <strong className="font-mono text-[var(--foreground)]">{totalStageSec}s</strong> (max 300s)
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                onChange({
                  ...value,
                  stages: [...value.stages, { durationSec: 10, targetVus: 10 }],
                })
              }
            >
              <IconPlus size={14} />
              Add Stage
            </Button>
          </div>
        )}
      </div>

      {value.loadProfile === "ramping" ? (
        <div className="space-y-2">
          {value.stages.map((stage, idx) => (
            <div key={idx} className="grid grid-cols-12 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <span className="col-span-2 font-mono text-xs text-[var(--muted)]">Stage {idx + 1}</span>
              <div className="col-span-4 flex items-center gap-1.5">
                <span className="text-xs text-[var(--muted)]">Duration (s):</span>
                <Input
                  type="number"
                  min={1}
                  max={300}
                  className="h-8 text-xs"
                  value={stage.durationSec}
                  onChange={(e) => {
                    const dur = Number(e.target.value) || 1;
                    onChange({
                      ...value,
                      stages: value.stages.map((s, i) => (i === idx ? { ...s, durationSec: dur } : s)),
                    });
                  }}
                />
              </div>
              <div className="col-span-5 flex items-center gap-1.5">
                <span className="text-xs text-[var(--muted)]">Target VUs:</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  className="h-8 text-xs"
                  value={stage.targetVus}
                  onChange={(e) => {
                    const target = Math.max(0, Number(e.target.value) || 0);
                    onChange({
                      ...value,
                      stages: value.stages.map((s, i) => (i === idx ? { ...s, targetVus: target } : s)),
                    });
                  }}
                />
              </div>
              <div className="col-span-1 text-right">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={value.stages.length <= 1}
                  onClick={() =>
                    onChange({
                      ...value,
                      stages: value.stages.filter((_, i) => i !== idx),
                    })
                  }
                >
                  <IconTrash size={14} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <LoadShapePreview value={value} />
    </div>
  );
}
