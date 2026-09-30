export function BeaconMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10.25" stroke="currentColor" opacity="0.35" />
      <circle cx="12" cy="12" r="6.75" stroke="currentColor" opacity="0.6" />
      <path
        d="M12 3.5 13.4 10.6 20.5 12 13.4 13.4 12 20.5 10.6 13.4 3.5 12 10.6 10.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <BeaconMark size={22} />
      </span>
      <span className="brand-name">Astropath</span>
    </div>
  );
}
