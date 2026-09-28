import { Link } from "react-router";

export function NotFound() {
  return (
    <div className="page-narrow">
      <div className="card card-pad center-card rise">
        <h1>Nothing here</h1>
        <p className="card-sub">This page does not exist. If you followed a checkout link, ask the business for a new one.</p>
        <Link className="btn btn-primary" to="/">
          Go to Weir
        </Link>
      </div>
    </div>
  );
}
