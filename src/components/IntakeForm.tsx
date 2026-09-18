"use client";

import { useState } from "react";
import { PROJECT_TYPES, HEARD_ABOUT, intakeSchema, type Intake } from "@/lib/model";
import { FAILURE_MODES, type FailureMode } from "@/lib/ports/memory";

/**
 * The intake form.
 *
 * Validated against the same zod schema the API uses, so the two cannot drift. Errors
 * are per-field and written as instructions rather than complaints — "Use a UK number,
 * like 07700 900123" tells someone what to do; "Invalid phone" does not.
 */

const EXAMPLE: Intake = {
  contactName: "Sasha Vance",
  company: "Wilder & Co",
  email: "sasha@wilderandco.example",
  phone: "07700 900512",
  projectType: "Social campaign",
  budgetGbp: 6500,
  deadline: "2026-11-20",
  brief:
    "Launch campaign for our winter range. Ten to twelve assets for Instagram and TikTok, plus a thirty-second hero cut for paid. We have brand guidelines and product shots already.",
  heardAbout: "Referral",
  marketingConsent: true,
};

const BLANK: Intake = {
  contactName: "",
  company: "",
  email: "",
  phone: "",
  projectType: "Brand film",
  budgetGbp: 5000,
  deadline: "",
  brief: "",
  heardAbout: undefined,
  marketingConsent: false,
};

export interface IntakeFormProps {
  busy: boolean;
  failureMode: FailureMode;
  onFailureModeChange: (mode: FailureMode) => void;
  onSubmit: (intake: Intake) => void;
}

export function IntakeForm({ busy, failureMode, onFailureModeChange, onSubmit }: IntakeFormProps) {
  const [values, setValues] = useState<Intake>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set<K extends keyof Intake>(key: K, value: Intake[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
    // Clear the error as soon as they start fixing it, not on the next submit.
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = intakeSchema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
      setErrors(next);
      // Move focus to the first thing that is wrong, rather than making them hunt.
      const first = Object.keys(next)[0];
      if (first) document.getElementById(first)?.focus();
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  }

  const selected = FAILURE_MODES.find((mode) => mode.id === failureMode);

  return (
    <section className="card" aria-label="New brief">
      <div className="card__head">
        <h2 className="card__title">New brief</h2>
        <button type="button" className="btn btn--quiet" onClick={() => setValues(EXAMPLE)} disabled={busy}>
          Fill with an example
        </button>
      </div>

      <div className="card__body">
        <form className="form" onSubmit={handleSubmit} noValidate>
          <div className="row">
            <Field id="contactName" label="Your name" error={errors.contactName}>
              <input
                id="contactName"
                value={values.contactName}
                onChange={(event) => set("contactName", event.target.value)}
                autoComplete="name"
                disabled={busy}
              />
            </Field>
            <Field id="company" label="Company" error={errors.company}>
              <input
                id="company"
                value={values.company}
                onChange={(event) => set("company", event.target.value)}
                autoComplete="organization"
                disabled={busy}
              />
            </Field>
          </div>

          <div className="row">
            <Field id="email" label="Email" error={errors.email}>
              <input
                id="email"
                type="email"
                value={values.email}
                onChange={(event) => set("email", event.target.value)}
                autoComplete="email"
                disabled={busy}
              />
            </Field>
            <Field id="phone" label="Phone" error={errors.phone} hint="Optional">
              <input
                id="phone"
                value={values.phone ?? ""}
                onChange={(event) => set("phone", event.target.value)}
                autoComplete="tel"
                disabled={busy}
              />
            </Field>
          </div>

          <div className="row">
            <Field id="projectType" label="What do you need?" error={errors.projectType}>
              <select
                id="projectType"
                value={values.projectType}
                onChange={(event) => set("projectType", event.target.value as Intake["projectType"])}
                disabled={busy}
              >
                {PROJECT_TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </Field>
            <Field id="budgetGbp" label="Budget (£)" error={errors.budgetGbp} hint="Ballpark is fine">
              <input
                id="budgetGbp"
                type="number"
                min={500}
                step={100}
                value={Number.isNaN(values.budgetGbp) ? "" : values.budgetGbp}
                onChange={(event) => set("budgetGbp", Number(event.target.value))}
                disabled={busy}
              />
            </Field>
          </div>

          <div className="row">
            <Field id="deadline" label="Needed by" error={errors.deadline}>
              <input
                id="deadline"
                type="date"
                value={values.deadline}
                onChange={(event) => set("deadline", event.target.value)}
                disabled={busy}
              />
            </Field>
            <Field id="heardAbout" label="How did you find us?" error={errors.heardAbout} hint="Optional">
              <select
                id="heardAbout"
                value={values.heardAbout ?? ""}
                onChange={(event) =>
                  set("heardAbout", (event.target.value || undefined) as Intake["heardAbout"])
                }
                disabled={busy}
              >
                <option value="">Prefer not to say</option>
                {HEARD_ABOUT.map((source) => (
                  <option key={source}>{source}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field id="brief" label="Tell us about the project" error={errors.brief}>
            <textarea
              id="brief"
              value={values.brief}
              onChange={(event) => set("brief", event.target.value)}
              disabled={busy}
            />
          </Field>

          <label className="checkline">
            <input
              type="checkbox"
              checked={values.marketingConsent}
              onChange={(event) => set("marketingConsent", event.target.checked)}
              disabled={busy}
            />
            Happy for us to email you about our work now and then. We will not pass your details on.
          </label>

          <div className="actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? "Sending…" : "Send the brief"}
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setValues(BLANK)} disabled={busy}>
              Clear
            </button>
          </div>
        </form>
      </div>

      <div className="simulate">
        <label htmlFor="failureMode">Break something on purpose</label>
        <select
          id="failureMode"
          value={failureMode}
          onChange={(event) => onFailureModeChange(event.target.value as FailureMode)}
          disabled={busy}
        >
          {FAILURE_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
        <p>{selected?.describes}</p>
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field" data-invalid={Boolean(error)}>
      <label htmlFor={id}>
        {label}
        {hint ? <span className="field__hint"> · {hint}</span> : null}
      </label>
      {children}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
