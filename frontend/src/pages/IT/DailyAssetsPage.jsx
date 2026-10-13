import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import {
  cancelDayUseRequestAPI,
  createDayUseRequestAPI,
  downloadDayUseDocumentAPI,
  acknowledgeAndDownloadAcceptanceAPI,
  fetchDayUseMeAPI,
  returnDayUseRequestAPI,
  toastITApiFailure,
  uploadDayUseSignatureAPI,
} from "./Data";
import { formatDateTimeDDMMYYYY } from "../../utils/dateFormat";
import { dayUseItRemark, dayUseItemsLabel, dayUseTimeline } from "./dayUseDisplay";
import "./DailyAssets.css";

const STATUS_LABEL = {
  requested: "Requested",
  approved: "Approved",
  assigned: "Checked out",
  return_requested: "Return requested",
  overdue: "Overdue",
  rejected: "Rejected",
  cancelled: "Cancelled",
  returned: "Returned",
};

const EMPTY_DEVICE = () => ({ key: `d-${Date.now()}-${Math.random()}`, line_type: "device", hw_type: "Laptop", quantity: 1 });
const EMPTY_ACCESSORY = () => ({
  key: `a-${Date.now()}-${Math.random()}`,
  line_type: "accessory",
  description: "",
  quantity: 1,
});

/** Cancel only before physical assign: Requested ✅ | Approved ✅ | Assigned ❌ */
function canEmployeeCancel(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "requested" || s === "approved";
}

/** Return only after device is checked out. */
function canEmployeeRequestReturn(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "assigned" || s === "overdue";
}

function statusPillClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "approved" || s === "assigned") return "da-pill da-pill--approved";
  if (s === "requested" || s === "return_requested") return "da-pill da-pill--warn";
  if (s === "overdue" || s === "rejected") return "da-pill da-pill--alert";
  return "da-pill da-pill--muted";
}

function itemsLabel(row) {
  return dayUseItemsLabel(row);
}

function HistoryTimestamps({ row }) {
  const t = dayUseTimeline(row);
  return (
    <div className="da-history-times">
      <span>
        <em>Requested</em> {formatDateTimeDDMMYYYY(t.requestedAt) || "—"}
      </span>
      <span>
        <em>Assigned</em> {formatDateTimeDDMMYYYY(t.assignedAt) || "—"}
      </span>
      <span>
        <em>Return accepted</em> {formatDateTimeDDMMYYYY(t.returnedAt) || "—"}
      </span>
    </div>
  );
}

/** Convert API ISO (UTC) to datetime-local value in the browser timezone. */
function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local → ISO UTC for the API. */
function fromDatetimeLocalValue(local) {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function OpenRequestCard({ open, saving, onCancel, onReturn, onAcknowledge, onDownload }) {
  const status = String(open.status || "").toLowerCase();
  const canAck =
    ["assigned", "overdue", "return_requested"].includes(status) ||
    (status === "returned" && !open.documents?.acceptance);
  const needsAck = canAck && !open.documents?.acceptance;
  const hasAcceptance = Boolean(open.documents?.acceptance);
  const hasReturnAck = Boolean(open.documents?.return_ack);

  let hint = "";
  if (status === "approved") {
    hint = "IT approved this request. A device has not been handed over yet — you can still cancel.";
  } else if (status === "requested") {
    hint = "Waiting for IT approval. You can cancel until a device is assigned.";
  } else if (status === "assigned" || status === "overdue") {
    hint = needsAck
      ? "Acknowledge receipt to generate your Acceptance PDF, then request return when ready."
      : "Devices are checked out. Use Request return when you are ready to give them back.";
  } else if (status === "return_requested") {
    hint = "Return requested — IT will confirm receipt.";
  }

  return (
    <article className="da-card da-open-card">
      <div className="da-open-top">
        <div className="da-open-main">
          <div className="da-open-titles">
            <span className="da-code">{open.request_code}</span>
            <span className={statusPillClass(open.status)}>
              {STATUS_LABEL[open.status] || open.status}
            </span>
          </div>
          <p className="da-open-type">
            {itemsLabel(open)}
            {open.assignment?.asset_name ? ` — ${open.assignment.asset_name}` : ""}
          </p>
          <p className="da-open-meta">
            Expected return {formatDateTimeDDMMYYYY(open.expected_return_at)}
            {open.requested_notes?.trim() ? ` · Notes: ${open.requested_notes}` : ""}
          </p>
          {open.rejection_reason ? <p className="da-reject-note">Rejected: {open.rejection_reason}</p> : null}
          {hint ? <p className="da-open-hint">{hint}</p> : null}
        </div>

        <div className="da-open-actions">
          {needsAck && (
            <button
              type="button"
              className="da-btn da-btn--primary"
              disabled={saving}
              onClick={() => onAcknowledge(open.id)}
            >
              Acknowledge
            </button>
          )}
          {hasAcceptance && (
            <button
              type="button"
              className="da-btn da-btn--ghost"
              disabled={saving}
              onClick={() => onDownload(open.id, "acceptance")}
            >
              Acceptance PDF
            </button>
          )}
          {hasReturnAck && (
            <button
              type="button"
              className="da-btn da-btn--ghost"
              disabled={saving}
              onClick={() => onDownload(open.id, "return_ack")}
            >
              Return PDF
            </button>
          )}
          {canEmployeeCancel(open.status) && (
            <button type="button" className="da-btn da-btn--danger" disabled={saving} onClick={() => onCancel(open.id)}>
              Cancel
            </button>
          )}
          {canEmployeeRequestReturn(open.status) && (
            <button
              type="button"
              className={needsAck ? "da-btn da-btn--ghost" : "da-btn da-btn--primary"}
              disabled={saving}
              onClick={() => onReturn(open.id)}
            >
              Request return
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function DailyAssetsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState([EMPTY_DEVICE()]);
  const [accessories, setAccessories] = useState([]);
  const [notes, setNotes] = useState("");
  const [returnAt, setReturnAt] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchDayUseMeAPI();
      setMe(data);
      const types = data.hw_types || [];
      if (types.length) {
        setDevices((prev) =>
          prev.map((d) => (types.includes(d.hw_type) ? d : { ...d, hw_type: types[0] })),
        );
      }
      setReturnAt((prev) => prev || toDatetimeLocalValue(data.default_expected_return_at));
    } catch (err) {
      toastITApiFailure(err, "Unable to load Day-use Assets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSaving(true);
    try {
      await uploadDayUseSignatureAPI(file);
      toast.success("Signature saved");
      await load();
    } catch (err) {
      toastITApiFailure(err, "Could not save signature");
    } finally {
      setSaving(false);
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    const deviceItems = devices
      .filter((d) => d.hw_type)
      .map((d) => ({
        line_type: "device",
        hw_type: d.hw_type,
        quantity: Math.max(1, Math.min(50, Number(d.quantity) || 1)),
      }));
    const accessoryItems = accessories
      .map((a) => ({
        line_type: "accessory",
        description: String(a.description || "").trim(),
        quantity: Math.max(1, Math.min(50, Number(a.quantity) || 1)),
      }))
      .filter((a) => a.description);

    if (!deviceItems.length) {
      toast.error("Add at least one device");
      return;
    }
    const expectedReturnAt = fromDatetimeLocalValue(returnAt);
    if (!expectedReturnAt) {
      toast.error("Choose an expected return date and time");
      return;
    }

    setSaving(true);
    try {
      await createDayUseRequestAPI({
        notes,
        items: [...deviceItems, ...accessoryItems],
        expectedReturnAt,
      });
      toast.success("Request submitted");
      setNotes("");
      setDevices([EMPTY_DEVICE()]);
      setAccessories([]);
      setReturnAt(toDatetimeLocalValue(me?.default_expected_return_at));
      await load();
    } catch (err) {
      toastITApiFailure(err, "Could not create request");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="da-page">
        <div className="da-container">
          <div className="da-loading">Loading Day-use Assets…</div>
        </div>
      </div>
    );
  }

  if (me?.needs_signature) {
    return (
      <div className="da-page">
        <div className="da-container">
          <header className="da-topbar">
            <button type="button" className="da-back" onClick={() => navigate(-1)}>
              ← Back
            </button>
            <div className="da-title-block">
              <p className="da-kicker">My workspace</p>
              <h1 className="da-title">Day-use Assets</h1>
            </div>
          </header>
          <div className="da-card da-card--setup">
            <h2>Upload signature</h2>
            <p className="da-card-copy">
              Upload your signature once before you can request a day-use device. You can replace it later; old documents
              keep the old signature.
            </p>
            <label className="da-file">
              {saving ? "Uploading…" : "Choose PNG or JPG"}
              <input type="file" accept="image/png,image/jpeg" disabled={saving} onChange={onUpload} />
            </label>
          </div>
        </div>
      </div>
    );
  }

  const types = me?.hw_types || ["Laptop", "Mobile", "Desktop", "Tablet", "Dashcam", "ODCP"];
  const openRequests =
    Array.isArray(me?.open_requests) && me.open_requests.length
      ? me.open_requests
      : me?.open_request
        ? [me.open_request]
        : [];

  return (
    <div className="da-page">
      <div className="da-container">
        <header className="da-topbar">
          <button type="button" className="da-back" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <div className="da-title-block">
            <p className="da-kicker">My workspace</p>
            <h1 className="da-title">Day-use Assets</h1>
          </div>
          <label className="da-file da-file--small">
            Replace signature
            <input type="file" accept="image/png,image/jpeg" disabled={saving} onChange={onUpload} />
          </label>
        </header>

        <p className="da-sub">
          Request devices and accessories for day use or multi-day. Set the expected return date/time on each request
          (default {formatDateTimeDDMMYYYY(me?.default_expected_return_at) || "end of today"}). You can have multiple
          open requests.
        </p>

        {openRequests.length > 0 ? (
          <div className="da-open-stack">
            <h2 className="da-section-title">Open requests ({openRequests.length})</h2>
            {openRequests.map((open) => (
              <OpenRequestCard
                key={open.id}
                open={open}
                saving={saving}
                onCancel={async (id) => {
                  setSaving(true);
                  try {
                    await cancelDayUseRequestAPI(id);
                    toast.success("Request cancelled");
                    await load();
                  } catch (err) {
                    toastITApiFailure(err);
                  } finally {
                    setSaving(false);
                  }
                }}
                onReturn={async (id) => {
                  setSaving(true);
                  try {
                    await returnDayUseRequestAPI(id);
                    toast.success("Return requested");
                    await load();
                  } catch (err) {
                    toastITApiFailure(err);
                  } finally {
                    setSaving(false);
                  }
                }}
                onAcknowledge={async (id) => {
                  setSaving(true);
                  try {
                    await acknowledgeAndDownloadAcceptanceAPI(id);
                    toast.success("Acceptance PDF downloaded");
                    await load();
                  } catch (err) {
                    toastITApiFailure(err, "Could not generate acceptance PDF");
                  } finally {
                    setSaving(false);
                  }
                }}
                onDownload={(id, docType) =>
                  downloadDayUseDocumentAPI(id, docType).catch((err) => toastITApiFailure(err))
                }
              />
            ))}
          </div>
        ) : null}

        <form className="da-card da-form-card" onSubmit={onCreate}>
          <h2>New day-use request</h2>
          <p className="da-muted da-form-hint">Add one or more devices and optional accessories in a single submission.</p>

          <div className="da-lines-grid">
            <div className="da-lines">
              <div className="da-lines-head">
                <h3>Devices</h3>
                <button
                  type="button"
                  className="da-btn da-btn--ghost"
                  onClick={() => setDevices((prev) => [...prev, { ...EMPTY_DEVICE(), hw_type: types[0] || "Laptop" }])}
                >
                  + Device
                </button>
              </div>
              {devices.map((row, idx) => (
                <div className="da-line" key={row.key}>
                  <label className="da-field da-field--grow">
                    Type
                    <select
                      value={row.hw_type}
                      onChange={(e) =>
                        setDevices((prev) => prev.map((d, i) => (i === idx ? { ...d, hw_type: e.target.value } : d)))
                      }
                    >
                      {types.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="da-field da-field--qty">
                    Qty
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={row.quantity}
                      onChange={(e) =>
                        setDevices((prev) =>
                          prev.map((d, i) => (i === idx ? { ...d, quantity: e.target.value } : d)),
                        )
                      }
                    />
                  </label>
                  {devices.length > 1 ? (
                    <button
                      type="button"
                      className="da-btn da-btn--ghost da-line-remove"
                      aria-label="Remove device line"
                      onClick={() => setDevices((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="da-line-spacer" />
                  )}
                </div>
              ))}
            </div>

            <div className="da-lines">
              <div className="da-lines-head">
                <h3>Accessories</h3>
                <button
                  type="button"
                  className="da-btn da-btn--ghost"
                  onClick={() => setAccessories((prev) => [...prev, EMPTY_ACCESSORY()])}
                >
                  + Accessory
                </button>
              </div>
              {accessories.length === 0 ? (
                <p className="da-muted">Optional — e.g. SIM, charger, USB cable (free text).</p>
              ) : (
                accessories.map((row, idx) => (
                  <div className="da-line" key={row.key}>
                    <label className="da-field da-field--grow">
                      Description
                      <input
                        type="text"
                        maxLength={200}
                        placeholder="e.g. SIM / charger / USB"
                        value={row.description}
                        onChange={(e) =>
                          setAccessories((prev) =>
                            prev.map((a, i) => (i === idx ? { ...a, description: e.target.value } : a)),
                          )
                        }
                      />
                    </label>
                    <label className="da-field da-field--qty">
                      Qty
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={row.quantity}
                        onChange={(e) =>
                          setAccessories((prev) =>
                            prev.map((a, i) => (i === idx ? { ...a, quantity: e.target.value } : a)),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="da-btn da-btn--ghost da-line-remove"
                      aria-label="Remove accessory line"
                      onClick={() => setAccessories((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <label className="da-field">
            Expected return
            <input
              type="datetime-local"
              value={returnAt}
              onChange={(e) => setReturnAt(e.target.value)}
              required
            />
          </label>
          <p className="da-muted da-form-hint">Any time today, or a later day (up to 30 days).</p>

          <label className="da-field">
            Notes (optional)
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Any notes for IT…"
            />
          </label>
          <button type="submit" className="da-btn da-btn--primary" disabled={saving}>
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </form>

        <div className="da-card">
          <h2>History</h2>
          {(me?.requests || []).length === 0 ? (
            <p className="da-muted">No previous requests.</p>
          ) : (
            <ul className="da-list da-history-list">
              {(me.requests || []).map((r) => {
                const status = String(r.status || "").toLowerCase();
                const { label: remarkLabel, text: itRemark } = dayUseItRemark(r);
                return (
                  <li key={r.id} className="da-history-card">
                    <div className="da-history-row">
                      <div className="da-history-main">
                        <span className="da-code">{r.request_code}</span>
                        <span className="da-history-type">{itemsLabel(r)}</span>
                        <span className={statusPillClass(r.status)}>{STATUS_LABEL[r.status] || r.status}</span>
                      </div>
                      {r.documents?.acceptance ? (
                        <button
                          type="button"
                          className="da-btn da-btn--ghost da-btn--tiny"
                          onClick={() =>
                            downloadDayUseDocumentAPI(r.id, "acceptance").catch((err) =>
                              toastITApiFailure(err),
                            )
                          }
                        >
                          Acceptance PDF
                        </button>
                      ) : null}
                    </div>
                    <HistoryTimestamps row={r} />
                    {itRemark ? (
                      <p className={`da-history-remark${status === "rejected" ? " da-history-remark--reject" : ""}`}>
                        <span>{remarkLabel}:</span> {itRemark}
                      </p>
                    ) : null}
                    {r.documents?.return_ack ? (
                      <button
                        type="button"
                        className="da-btn da-btn--ghost da-btn--tiny"
                        onClick={() =>
                          downloadDayUseDocumentAPI(r.id, "return_ack").catch((err) => toastITApiFailure(err))
                        }
                      >
                        Return PDF
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
