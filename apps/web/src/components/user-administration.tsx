"use client";

import { useState } from "react";

type ManagedUser = {
  id: string;
  username: string;
  displayName: string;
  state: string;
  roles: string[];
  isSelf: boolean;
};

export function UserAdministration({
  users,
  csrfToken,
}: {
  users: ManagedUser[];
  csrfToken: string;
}) {
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  async function createUser(form: FormData) {
    setStatus("Creating invited account…");
    setActivationUrl(null);
    const roles = form.getAll("roles").map(String);
    const response = await fetch("/api/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        username: form.get("username"),
        displayName: form.get("displayName"),
        roles,
      }),
    });
    const result = (await response.json()) as {
      activationUrl?: string;
      error?: string;
    };
    if (response.ok && result.activationUrl) {
      setActivationUrl(result.activationUrl);
      setStatus(
        "Invitation created. Share this single-use link through an approved private channel, then refresh to update the list.",
      );
    } else setStatus(result.error ?? "Account creation failed.");
  }

  async function setState(user: ManagedUser, state: "ACTIVE" | "DEACTIVATED") {
    setStatus(
      `${state === "ACTIVE" ? "Reactivating" : "Deactivating"} ${user.displayName}…`,
    );
    const response = await fetch(`/api/users/${user.id}/state`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ state }),
    });
    if (response.ok) location.reload();
    else setStatus("User state change failed.");
  }

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Users</h2>
      </div>
      <div className="panelBody stack">
        <form action={createUser} className="stack" aria-label="Invite user">
          <div className="formGrid">
            <label className="field">
              Username
              <input
                name="username"
                required
                pattern="[a-z0-9][a-z0-9._-]{2,63}"
                maxLength={64}
              />
            </label>
            <label className="field">
              Display name
              <input name="displayName" required maxLength={120} />
            </label>
          </div>
          <fieldset className="roleChoices">
            <legend>Roles</legend>
            {["EDITOR", "REVIEWER", "PUBLISHER"].map((role) => (
              <label key={role}>
                <input type="checkbox" name="roles" value={role} />
                {role.toLowerCase()}
              </label>
            ))}
          </fieldset>
          <button className="button" type="submit">
            Create invitation
          </button>
        </form>
        <p className="formStatus" role="status" aria-live="polite">
          {status}
        </p>
        {activationUrl && (
          <div className="policyBanner activationBanner">
            <div className="activationDetails">
              <strong>Single-use activation link</strong>
              <code className="activationUrl">{activationUrl}</code>
            </div>
          </div>
        )}
        <ul className="timeline userList">
          {users.map((user) => (
            <li className="userRow" key={user.id}>
              <div className="userSummary">
                <strong>{user.displayName}</strong>{" "}
                <span className="badge">{user.state}</span>
                <br />
                <span className="muted">
                  {user.username} · {user.roles.join(", ") || "No role"}
                </span>
              </div>
              {!user.isSelf && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    setState(
                      user,
                      user.state === "DEACTIVATED" ? "ACTIVE" : "DEACTIVATED",
                    )
                  }
                >
                  {user.state === "DEACTIVATED" ? "Reactivate" : "Deactivate"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
