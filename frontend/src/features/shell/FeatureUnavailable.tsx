import { Link } from '@tanstack/react-router';

export function FeatureUnavailable({ feature }: { feature: string }) {
  return (
    <div className="list-group-item">
      <p role="status">{feature} is not available in this development build. Appearance, Extra, Shortcuts and Blacklist settings are ready to use.</p>
      <Link to="/app/settings" className="btn btn-primary">Open settings</Link>
    </div>
  );
}
