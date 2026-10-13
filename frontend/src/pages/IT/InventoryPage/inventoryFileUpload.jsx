import ClickableImage from "../../../components/ClickableImage";
import { openFirstImageInNewTab } from "../../../utils/openImageInNewTab";
import { isImageSrc } from "../../../utils/mediaSrc";
import { compressImage } from "../Data";

export const truncateFileName = (name, max = 22) => {
  if (!name) return "";
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
};

export const readFileAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error(`Failed to read: ${file.name}`));
    reader.readAsDataURL(file);
  });

/** @returns {{ data: string, name: string, isImage: boolean }[]} */
export async function encodeInventoryFiles(files, { imagesOnly = false } = {}) {
  const list = Array.from(files || []);
  if (!list.length) return [];

  return Promise.all(
    list.map(async (file) => {
      const name = file.name || "file";
      if (file.type?.startsWith("image/")) {
        try {
          const data = await compressImage(file);
          return { data, name, isImage: true };
        } catch {
          if (imagesOnly) throw new Error(`Could not process image: ${name}`);
          const data = await readFileAsDataURL(file);
          return { data, name, isImage: false };
        }
      }
      if (imagesOnly) {
        throw new Error(`${name} is not an image.`);
      }
      const data = await readFileAsDataURL(file);
      return { data, name, isImage: false };
    }),
  );
}

const FIELD_META = {
  photos: {
    namesKey: "photoNames",
    uploadingKey: "photoUploading",
    pendingKey: "_uploadingPhotoNames",
  },
  receipts: {
    namesKey: "receiptNames",
    uploadingKey: "receiptUploading",
    pendingKey: "_uploadingReceiptNames",
  },
};

export function getFieldMeta(field) {
  return FIELD_META[field] || FIELD_META.photos;
}

/**
 * Table cell: upload button + file name list (photos or receipts).
 */
export function InventoryFileCell({
  row,
  field,
  buttonLabel,
  accept,
  imagesOnly = false,
  onUpload,
  onPreview,
}) {
  const meta = getFieldMeta(field);
  const names = row[meta.namesKey] || [];
  const uploading = Boolean(row[meta.uploadingKey]);
  const pending = row[meta.pendingKey] || [];
  const count = (row[field] || []).length;

  const handleChange = (e) => {
    onUpload(row.id, field, e.target.files, { imagesOnly });
    e.target.value = "";
  };

  return (
    <td className="ana-td-photos">
      <div className="ana-photo-cell">
        <label
          className={`ana-photo-btn ${uploading ? "is-uploading" : ""}`}
          title={uploading ? "Processing file…" : `Select ${buttonLabel.toLowerCase()}`}
        >
          <input
            type="file"
            accept={accept}
            multiple
            style={{ display: "none" }}
            disabled={uploading}
            onChange={handleChange}
          />
          {uploading ? "Uploading…" : buttonLabel}
        </label>

        {(names.length > 0 || pending.length > 0) && (
          <ul className="ana-photo-file-list" aria-live="polite">
            {names.map((name, i) => (
              <li key={`${field}-done-${name}-${i}`} title={name}>
                <span className="ana-photo-file-name">{truncateFileName(name)}</span>
                <span className="ana-photo-file-status ana-photo-file-status--done">Ready</span>
              </li>
            ))}
            {uploading &&
              pending.map((name, i) => (
                <li key={`${field}-pending-${name}-${i}`} className="is-pending" title={name}>
                  <span className="ana-photo-file-name">{truncateFileName(name)}</span>
                  <span className="ana-photo-file-status">Uploading…</span>
                </li>
              ))}
          </ul>
        )}

        {count > 0 && onPreview && (
          <button
            type="button"
            className="ana-photo-count-btn"
            onClick={() => {
              const items = buildPreviewItems(row, field);
              const firstImage = items.find(
                (it) => it.isImage && isImageSrc(it.data),
              );
              if (firstImage?.data && openFirstImageInNewTab([firstImage.data])) return;
              onPreview(row.id, field);
            }}
            title="Open photo in new tab"
          >
            View ({count})
          </button>
        )}
      </div>
    </td>
  );
}

export function FilePreviewModal({ items, title, onClose, onRemove }) {
  return (
    <div className="ana-photo-modal-backdrop" onClick={onClose}>
      <div className="ana-photo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ana-photo-modal-head">
          <span>{title || `${items.length} file${items.length !== 1 ? "s" : ""}`}</span>
          <button type="button" className="ana-photo-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="ana-photo-modal-body">
          <div className="ana-photo-grid">
            {items.map((item, i) => (
              <div key={i} className="ana-photo-item">
                {item.isImage && isImageSrc(item.data) ? (
                  <ClickableImage src={item.data} alt={item.name || ""} />
                ) : (
                  <div className="ana-file-preview-tag" title={item.name}>
                    📄 {truncateFileName(item.name, 18)}
                  </div>
                )}
                <button type="button" className="ana-photo-remove" onClick={() => onRemove(i)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Build preview items from parallel data + names arrays. */
export function buildPreviewItems(dataUrls = [], names = []) {
  return (dataUrls || []).map((data, i) => {
    const name = names[i] || `File ${i + 1}`;
    const isImage = isImageSrc(data);
    return { data, name, isImage };
  });
}
