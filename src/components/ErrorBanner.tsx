interface Props {
  errors: string[];
  onDismiss: () => void;
}

export default function ErrorBanner({ errors, onDismiss }: Props) {
  if (errors.length === 0) return null;

  return (
    <div className="error-banner">
      <div className="error-content">
        <strong>Error{errors.length > 1 ? "s" : ""}:</strong>
        <ul>
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
      <button className="btn-dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
