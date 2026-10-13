import { openImageInNewTab } from "../utils/openImageInNewTab";
import "./ClickableImage.css";

/**
 * Image that opens full size in a new tab when clicked (unless onClick overrides).
 */
export default function ClickableImage({
  src,
  alt = "Photo",
  className = "",
  title = "Open full image in new tab",
  onClick,
  ...rest
}) {
  if (!src) return null;

  const handleActivate = (e) => {
    e.stopPropagation();
    if (typeof onClick === "function") {
      onClick(e);
      return;
    }
    openImageInNewTab(src);
  };

  return (
    <img
      src={src}
      alt={alt}
      className={["clickable-image", className].filter(Boolean).join(" ")}
      title={title}
      loading="lazy"
      decoding="async"
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleActivate(e);
        }
      }}
      {...rest}
    />
  );
}
