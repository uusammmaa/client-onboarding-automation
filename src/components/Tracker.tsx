"use client";

import type { ClientRecord, DeliveryStatus, PaymentStatus } from "@/lib/model";
import { depositAmountGbp } from "@/lib/model";

/**
 * The tracker.
 *
 * This is the thing the client asked for — one place that says who owes money and what is
 * late. Everything else on the page exists to put rows into it.
 */

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function formatDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : shortDate.format(date);
}

type Tone = "green" | "red" | "amber" | "blue" | "grey";

const PAYMENT_TONE: Record<PaymentStatus, Tone> = {
  "Awaiting deposit": "amber",
  "Deposit paid": "blue",
  Invoiced: "blue",
  "Paid in full": "green",
  Overdue: "red",
};

const DELIVERY_TONE: Record<DeliveryStatus, Tone> = {
  "Not started": "grey",
  "In progress": "blue",
  "With client for review": "amber",
  Delivered: "green",
};

export interface LedgerTotals {
  onTheBooks: number;
  collected: number;
  outstanding: number;
  overdueCount: number;
  awaitingReview: number;
}

export function ledgerTotals(clients: ClientRecord[]): LedgerTotals {
  // "Lost" work was never real money, so it is excluded from every figure. Counting it
  // would make the books look healthier than they are, which is the one direction a
  // finance summary must never be wrong in.
  const live = clients.filter((client) => client.status !== "Lost");
  const onTheBooks = live.reduce((sum, client) => sum + client.budgetGbp, 0);
  const collected = live.reduce((sum, client) => sum + client.amountPaidGbp, 0);

  return {
    onTheBooks,
    collected,
    outstanding: onTheBooks - collected,
    overdueCount: live.filter((client) => client.paymentStatus === "Overdue").length,
    awaitingReview: live.filter((client) => client.deliveryStatus === "With client for review").length,
  };
}

export function Ledger({ clients }: { clients: ClientRecord[] }) {
  const totals = ledgerTotals(clients);

  return (
    <section className="ledger" aria-label="Ledger summary">
      <div className="ledger__cell">
        <span className="ledger__label">On the books</span>
        <div className="ledger__figure">{gbp.format(totals.onTheBooks)}</div>
        <span className="ledger__note">
          {clients.length} {clients.length === 1 ? "client" : "clients"}
        </span>
      </div>
      <div className="ledger__cell" data-tone="green">
        <span className="ledger__label">Collected</span>
        <div className="ledger__figure">{gbp.format(totals.collected)}</div>
        <span className="ledger__note">
          {totals.onTheBooks > 0 ? `${Math.round((totals.collected / totals.onTheBooks) * 100)}% of the total` : "—"}
        </span>
      </div>
      <div className="ledger__cell" data-tone={totals.outstanding > 0 ? "red" : undefined}>
        <span className="ledger__label">Outstanding</span>
        <div className="ledger__figure">{gbp.format(totals.outstanding)}</div>
        <span className="ledger__note">
          {totals.overdueCount === 0
            ? "Nothing overdue"
            : `${totals.overdueCount} ${totals.overdueCount === 1 ? "account" : "accounts"} overdue`}
        </span>
      </div>
      <div className="ledger__cell">
        <span className="ledger__label">With clients</span>
        <div className="ledger__figure">{totals.awaitingReview}</div>
        <span className="ledger__note">Waiting on sign-off</span>
      </div>
    </section>
  );
}

export function Tracker({ clients, freshId }: { clients: ClientRecord[]; freshId?: string }) {
  if (clients.length === 0) {
    return <p className="empty">Nothing on the tracker yet. Send a brief and the first row appears here.</p>;
  }

  return (
    <div className="tracker">
      <table>
        <caption className="sr-only">Client tracker: status, payment and delivery for every brief</caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Company</th>
            <th scope="col">Project</th>
            <th scope="col" style={{ textAlign: "right" }}>
              Budget
            </th>
            <th scope="col" style={{ textAlign: "right" }}>
              Paid
            </th>
            <th scope="col">Payment</th>
            <th scope="col">Deposit due</th>
            <th scope="col">Delivery</th>
            <th scope="col">Deadline</th>
            <th scope="col">Owner</th>
            <th scope="col">Folder</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => {
            const deposit = depositAmountGbp(client.budgetGbp);
            const shortfall = client.amountPaidGbp < deposit && client.paymentStatus !== "Paid in full";
            return (
              <tr key={client.clientId} data-fresh={client.clientId === freshId}>
                <td>{client.clientId}</td>
                <td>
                  {client.company}
                  <br />
                  <span style={{ color: "var(--ink-faint)", fontSize: "0.82rem" }}>{client.contactName}</span>
                </td>
                <td>{client.projectType}</td>
                <td className="num">{gbp.format(client.budgetGbp)}</td>
                <td className="num">
                  {gbp.format(client.amountPaidGbp)}
                  {shortfall ? (
                    <>
                      <br />
                      <span style={{ color: "var(--ink-faint)", fontSize: "0.78rem" }}>
                        of {gbp.format(deposit)} deposit
                      </span>
                    </>
                  ) : null}
                </td>
                <td>
                  <span className="pill" data-tone={PAYMENT_TONE[client.paymentStatus] ?? "grey"}>
                    {client.paymentStatus}
                  </span>
                </td>
                <td>{formatDate(client.depositDue)}</td>
                <td>
                  <span className="pill" data-tone={DELIVERY_TONE[client.deliveryStatus] ?? "grey"}>
                    {client.deliveryStatus}
                  </span>
                </td>
                <td>{formatDate(client.deadline)}</td>
                <td>{client.owner}</td>
                <td>
                  {client.driveFolderUrl ? (
                    <a href={client.driveFolderUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : (
                    <span style={{ color: "var(--red)" }}>Missing</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
