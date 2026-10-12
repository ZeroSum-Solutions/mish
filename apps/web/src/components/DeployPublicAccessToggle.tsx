// The one "Make preview public" control for Vercel deploys, shared by the file
// viewer's deploy modal and the Design Index first-draft card, plus the link
// access reading both show next to a deployed URL.
import { useT } from '../i18n';

export type DeployLinkAccess = 'public' | 'protected' | 'unknown';

/** The validated `access` the daemon puts on a deployment; anything else is unknown. */
export function deployAccessOf(deployment: { access?: string } | null | undefined): DeployLinkAccess {
  const access = deployment?.access;
  return access === 'public' || access === 'protected' ? access : 'unknown';
}

/** The localized sentence for a deployed link's access. */
export function useDeployAccessMessage(): (access: DeployLinkAccess) => string {
  const t = useT();
  return (access) => {
    if (access === 'public') return t('fileViewer.deployAccessPublic');
    if (access === 'protected') return t('fileViewer.deployLinkProtected');
    return t('fileViewer.deployAccessUnknown');
  };
}

export function DeployPublicAccessToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="deploy-public-access-field">
      <label className="deploy-public-access-toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
          data-testid="deploy-public-access"
        />
        <span className="deploy-field-title">{t('fileViewer.deployPublicAccessLabel')}</span>
      </label>
      <p className="hint">{t('fileViewer.deployPublicAccessHint')}</p>
    </div>
  );
}
