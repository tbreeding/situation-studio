"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";

type UserItem = {
  id: string;
  username: string;
  displayName: string;
  state: string;
  roles: string[];
  lastLoginAt: string | null;
};

type CheckoutItem = {
  id: string;
  situationId: string;
  situationTitle: string;
  holderName: string;
  acquiredAt: string;
};

export function OperationsDashboard({
  users,
  checkouts,
  csrfToken,
}: {
  users: UserItem[];
  checkouts: CheckoutItem[];
  csrfToken: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({
    username: "",
    displayName: "",
    password: "",
    admin: false,
  });

  function request(
    url: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
  ) {
    setMessage(null);
    startTransition(async () => {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "The action could not be completed.");
        return;
      }
      setMessage("Saved.");
      router.refresh();
    });
  }

  return (
    <div className="operationsGrid">
      {message ? (
        <p className="operationsMessage" role="status">
          {message}
        </p>
      ) : null}
      <section className="operationsCard userCard">
        <header>
          <div>
            <p className="cardEyebrow">Access</p>
            <h2>Users</h2>
          </div>
          <span>{users.length} accounts</span>
        </header>
        <div className="userList">
          {users.map((user) => (
            <article key={user.id}>
              <div className="userIdentity">
                <span className="avatar" aria-hidden="true">
                  {user.displayName
                    .split(/\s+/u)
                    .map((word) => word[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <div>
                  <strong>{user.displayName}</strong>
                  <span>@{user.username}</span>
                </div>
              </div>
              <span className="roleLabel">{user.roles.join(" · ")}</span>
              <span className={`userState state-${user.state.toLowerCase()}`}>
                {user.state}
              </span>
              <div className="userActions">
                <button
                  className="textButton"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const password = window.prompt(
                      `Enter a new password for ${user.displayName} (12+ characters).`,
                    );
                    if (password)
                      request(`/api/users/${user.id}/password`, "POST", {
                        password,
                      });
                  }}
                >
                  Reset password
                </button>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    request(`/api/users/${user.id}/state`, "PATCH", {
                      active: user.state !== "ACTIVE",
                    })
                  }
                >
                  {user.state === "ACTIVE" ? "Deactivate" : "Reactivate"}
                </button>
              </div>
            </article>
          ))}
        </div>
        <form
          className="createUserForm"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            request("/api/users", "POST", newUser);
          }}
        >
          <h3>Create account</h3>
          <label>
            <span>Username</span>
            <input
              name="new-username"
              autoComplete="off"
              disabled={!hydrated || pending}
              value={newUser.username}
              onChange={(event) =>
                setNewUser((current) => ({
                  ...current,
                  username: event.target.value,
                }))
              }
              required
            />
          </label>
          <label>
            <span>Display name</span>
            <input
              name="display-name"
              autoComplete="off"
              disabled={!hydrated || pending}
              value={newUser.displayName}
              onChange={(event) =>
                setNewUser((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              required
            />
          </label>
          <label>
            <span>Initial password</span>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              disabled={!hydrated || pending}
              value={newUser.password}
              minLength={12}
              onChange={(event) =>
                setNewUser((current) => ({
                  ...current,
                  password: event.target.value,
                }))
              }
              required
            />
          </label>
          <label className="checkboxLabel">
            <input
              type="checkbox"
              disabled={!hydrated || pending}
              checked={newUser.admin}
              onChange={(event) =>
                setNewUser((current) => ({
                  ...current,
                  admin: event.target.checked,
                }))
              }
            />
            <span>Administrator</span>
          </label>
          <button
            className="primaryButton"
            type="submit"
            disabled={!hydrated || pending}
          >
            Create user
          </button>
        </form>
      </section>

      <section className="operationsCard">
        <header>
          <div>
            <p className="cardEyebrow">Durable ownership</p>
            <h2>Active checkouts</h2>
          </div>
          <span>{checkouts.length} held</span>
        </header>
        <div className="checkoutList">
          {checkouts.map((checkout) => (
            <article key={checkout.id}>
              <div>
                <strong>{checkout.situationTitle}</strong>
                <span>
                  Held by {checkout.holderName} since{" "}
                  {new Date(checkout.acquiredAt).toLocaleString()}
                </span>
              </div>
              <button
                className="secondaryButton"
                type="button"
                disabled={pending}
                onClick={() => {
                  const reason = window.prompt(
                    "Record the reason for force-checking this situation in.",
                  );
                  if (reason)
                    request(
                      `/api/situations/${checkout.situationId}/force-check-in`,
                      "POST",
                      { reason },
                    );
                }}
              >
                Force check in
              </button>
            </article>
          ))}
          {!checkouts.length ? (
            <div className="emptyState">
              <strong>No situations are checked out.</strong>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
