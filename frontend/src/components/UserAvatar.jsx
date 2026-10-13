import React, { useEffect, useMemo, useState } from 'react';
import { getUserPhotoUrl, makeInitialsAvatar } from '../utils/userPhoto';
import {
  fetchAuthenticatedObjectUrl,
  isAlreadySignedFileUrl,
  isLegacyStaticUploadUrl,
  toPathOnly,
} from '../utils/secureFileUrl';

/**
 * User/employee avatar: shows uploaded photo when available, else initials.
 * Private uploads are loaded with JWT or signed URLs (never anonymous /static/uploads).
 */
export function UserAvatar({
  user,
  photo,
  photoUrl,
  photo_url,
  name = '',
  className = '',
  imgClassName = '',
  alt,
  initialsBg = '#4CAF50',
  as = 'img',
}) {
  const displayName = name || user?.name || user?.fullName || '';
  const resolvedPhoto = useMemo(
    () => getUserPhotoUrl(user) || normalizeFromProps(photo_url, photoUrl, photo),
    [user, photo, photoUrl, photo_url],
  );
  const fallbackSrc = useMemo(
    () => makeInitialsAvatar(displayName, initialsBg),
    [displayName, initialsBg],
  );
  const [failed, setFailed] = useState(false);
  const [blobSrc, setBlobSrc] = useState('');

  useEffect(() => {
    setFailed(false);
    let revoke = () => {};
    let cancelled = false;

    const path = toPathOnly(resolvedPhoto);
    const needsAuthFetch =
      path &&
      !isAlreadySignedFileUrl(path) &&
      (isLegacyStaticUploadUrl(path) ||
        path.startsWith('/api/files/content/') ||
        path.includes('/api/accounts/file/'));

    if (!path) {
      setBlobSrc('');
      return undefined;
    }

    if (isAlreadySignedFileUrl(path)) {
      setBlobSrc(path);
      return undefined;
    }

    if (!needsAuthFetch) {
      // Public/non-upload URL
      setBlobSrc(path);
      return undefined;
    }

    setBlobSrc('');
    (async () => {
      const result = await fetchAuthenticatedObjectUrl(resolvedPhoto);
      if (cancelled) {
        result.revoke();
        return;
      }
      revoke = result.revoke;
      setBlobSrc(result.objectUrl || '');
      if (!result.objectUrl) setFailed(true);
    })();

    return () => {
      cancelled = true;
      revoke();
    };
  }, [resolvedPhoto]);

  const src = !failed && blobSrc ? blobSrc : fallbackSrc;

  if (as === 'span') {
    return (
      <span className={className} aria-hidden>
        <img
          src={src}
          alt=""
          className={imgClassName}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
        />
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt ?? (displayName || 'User')}
      className={className || imgClassName}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function normalizeFromProps(...values) {
  for (const v of values) {
    const u = getUserPhotoUrl({ photo: v, photo_url: v, photoUrl: v });
    if (u) return u;
  }
  return '';
}
