import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import ProviderAuthSection from "./ProviderAuthSection";
import {
  providerLoginOauth,
  providerLoginOidc,
  providerLoginPasteToken,
  providerLoginSsoChooseTeam,
  providerLoginSsoPoll,
  type ProviderBudgetRowDto,
  type ProviderConfig,
  type ProviderLoginStep,
} from "@/lib/tauri";

/**
 * The provider auth surface (issue #126 / #127 / #132) — the standalone
 * `McpSection.test.tsx` pattern: a pure-prop render, a module-path barrel mock
 * spreading `vi.importActual` (so `describeIpcError`, which rides in through
 * `@/lib/ipcError`, and every untouched export keep working), and overrides for
 * ONLY the FIVE interactive-login commands this section calls.
 *
 * `getProviderBudget` is deliberately NOT mocked here: the budget read is the
 * PAGE's fetch (`SettingsPage`), and this section receives the rows as a prop —
 * so the section never calls it and the test never has to intercept it.
 */
vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    providerLoginOauth: vi.fn(),
    providerLoginOidc: vi.fn(),
    providerLoginSsoPoll: vi.fn(),
    providerLoginSsoChooseTeam: vi.fn(),
    providerLoginPasteToken: vi.fn(),
  };
});

const mockedOauth = vi.mocked(providerLoginOauth);
const mockedOidc = vi.mocked(providerLoginOidc);
const mockedPoll = vi.mocked(providerLoginSsoPoll);
const mockedChoose = vi.mocked(providerLoginSsoChooseTeam);
const mockedPaste = vi.mocked(providerLoginPasteToken);

/** A provider row, minimal but complete (the optional auth fields omitted). */
function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "tama",
    name: "Tama",
    baseUrl: "https://tama.wizards.town/v1",
    apiKey: "k",
    api: "litellm",
    ...overrides,
  };
}

/** The narrow step types (so a fixture is CHECKED against the wire union — a
 * field the landed DTO does not carry is a compile error, not a silent extra). */
type PendingStep = Extract<ProviderLoginStep, { status: "devicePending" }>;
type ChooseTeamStep = Extract<ProviderLoginStep, { status: "chooseTeam" }>;

/** The `devicePending` step the CLI-SSO fallback answers with. */
const pending: PendingStep = {
  status: "devicePending",
  loginId: "login-1",
  pollSecret: "secret-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://tama.test/sso/key/generate?login=login-1",
};

const authenticated: ProviderLoginStep = { status: "authenticated" };

/** The poll's TERMINAL sentence (there is no `expired` step on the wire). */
const EXPIRED =
  "the CLI SSO session has expired or does not exist (HTTP 400) — restart the login";

/** One budget row (the landed camelCase `ProviderBudgetDto` shape). */
function keyRow(
  overrides: Partial<ProviderBudgetRowDto> = {},
): ProviderBudgetRowDto {
  return {
    level: "key",
    entitled: true,
    label: null,
    spend: 12.34,
    maxBudget: 100,
    remaining: 87.66,
    budgetResetAt: null,
    ...overrides,
  };
}

/** Render the section standalone — pure props, no store, no page. */
function renderSection(
  overrides: Partial<ProviderConfig> = {},
  options: {
    budget?: ProviderBudgetRowDto[];
    onCommitField?: (patch: Partial<ProviderConfig>) => void;
  } = {},
): { onCommitField: (patch: Partial<ProviderConfig>) => void } {
  // A case that renders twice (the "absent budget renders nothing" pair, the
  // oidc-only-fields pair) needs the first tree gone, or the queries would see
  // two matches. `afterEach` also cleans up; this is the WITHIN-case half.
  cleanup();
  const onCommitField = options.onCommitField ?? vi.fn();
  render(
    <ProviderAuthSection
      provider={provider(overrides)}
      budget={options.budget}
      onCommitField={onCommitField}
      className="sm:col-span-2"
    />,
  );
  return { onCommitField };
}

/** Flush the microtask queue (the mocked commands resolve immediately). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Advance fake time and flush what the timers scheduled.
 *
 * The leading flush is load-bearing: the Sign-in click's
 * `await providerLoginOauth(…)` must LAND IN STATE before the poll effect runs,
 * or there is no interval to advance and the test would pass or fail for a
 * reason unrelated to the code under test. The trailing flush is the mirror
 * image — a poll response resolves inside the timer callback and its `setState`
 * needs a tick to reach the DOM.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

/** Click the row's Sign-in button. */
async function clickSignIn(name = "Tama"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: `Sign in ${name}` }));
  await flush();
}

// The team-choice panel is a Radix `Select`, and opening one in jsdom throws
// `hasPointerCapture is not a function` without these stubs (the
// `SettingsPage.test.tsx` / `SessionConfigSelect.test.tsx` beforeAll, verbatim).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

beforeEach(() => {
  mockedOauth.mockReset();
  mockedOidc.mockReset();
  mockedPoll.mockReset();
  mockedChoose.mockReset();
  mockedPaste.mockReset();
});

afterEach(() => {
  // A leaked 2 s poll interval is a CROSS-FILE hazard (this suite is
  // file-order sensitive), so the real timers go back after every case.
  cleanup();
  vi.useRealTimers();
});

describe("ProviderAuthSection — which rows get a Sign-in", () => {
  it("an api_key row and a gcloud_adc row render NO Sign-in button", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: "Sign in Tama" })).toBeNull();
    cleanup();
    renderSection({ authMode: "gcloud_adc" });
    expect(screen.queryByRole("button", { name: "Sign in Tama" })).toBeNull();
  });

  it("an absent authMode renders NO Sign-in button (the keyUrl-precedent absence)", () => {
    // `authMode` is OPTIONAL: a pre-feature document has no key at all and the
    // section must read the absence as `api_key`, not as "offer a login".
    renderSection({ authMode: undefined });
    expect(screen.queryByRole("button", { name: "Sign in Tama" })).toBeNull();
  });

  it("an oauth row renders the Sign-in button", () => {
    renderSection({ authMode: "oauth" });
    expect(screen.getByRole("button", { name: "Sign in Tama" })).toBeTruthy();
  });

  it("an oidc row renders the Sign-in button", () => {
    renderSection({ authMode: "oidc", oidc: { issuer: "https://idp.test" } });
    expect(screen.getByRole("button", { name: "Sign in Tama" })).toBeTruthy();
  });

  it("the section adds NO border-t element (the row-pin the page tests lean on)", () => {
    const { container } = render(
      <ProviderAuthSection
        provider={provider({ authMode: "oauth" })}
        budget={[keyRow()]}
        onCommitField={vi.fn()}
        className="sm:col-span-2"
      />,
    );
    expect(container.querySelector(".border-t")).toBeNull();
    expect(container.querySelector(".border-t-0")).toBeNull();
  });
});

describe("ProviderAuthSection — the Sign-in machine (the McpSection shape)", () => {
  it("an oauth Sign-in calls providerLoginOauth(id, baseUrl) and shows the authenticated badge", async () => {
    mockedOauth.mockResolvedValue(authenticated);
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    expect(mockedOauth).toHaveBeenCalledWith(
      "tama",
      "https://tama.wizards.town/v1",
    );
    expect(await screen.findByText("authenticated")).toBeTruthy();
  });

  it("the in-flight state shows the signing-in… badge while the command blocks", async () => {
    // `provider_login_oauth` BLOCKS up to 10 minutes (the authMcpServer shape) —
    // the badge is the ONLY feedback during that block, so it must appear while
    // the promise is unsettled, and the button must be disabled.
    let resolve!: (step: ProviderLoginStep) => void;
    mockedOauth.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection({ authMode: "oauth" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    expect(screen.getByText("signing in…")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Sign in Tama",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    resolve(authenticated);
    expect(await screen.findByText("authenticated")).toBeTruthy();
  });

  it("an oidc Sign-in calls providerLoginOidc(id, oidc) and maps the STRING return to authenticated", async () => {
    // The landed `provider_login_oidc` is `Result<String, SettingsError>` — the
    // "{providerId}: authenticated" string, NOT the step DTO. The section must
    // recognise the string, not try to read `.status` off it.
    mockedOidc.mockResolvedValue("tama: authenticated");
    renderSection({
      authMode: "oidc",
      oidc: { issuer: "https://idp.test", clientId: "cid", scope: "openid" },
    });
    await clickSignIn();
    expect(mockedOidc).toHaveBeenCalledWith("tama", {
      issuer: "https://idp.test",
      clientId: "cid",
      scope: "openid",
    });
    expect(await screen.findByText("authenticated")).toBeTruthy();
  });

  it("a rejection rides describeIpcError into the error badge's title", async () => {
    mockedOauth.mockRejectedValue({
      kind: "provider_auth_failed",
      message: "provider login failed: discovery document not found",
    });
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    const badge = await screen.findByText("error");
    expect(
      badge.getAttribute("title"),
    ).toBe("provider login failed: discovery document not found");
  });

  it("Sign in is re-enabled after a failure (a dead button would strand the row)", async () => {
    mockedOauth.mockRejectedValue({ message: "provider login failed: boom" });
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    expect(await screen.findByText("error")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Sign in Tama",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe("ProviderAuthSection — the device-flow panel + the 2 s poll", () => {
  it("a devicePending step renders the user code, the verification URL and a cancel", async () => {
    mockedOauth.mockResolvedValue(pending);
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    expect(
      (screen.getByRole("textbox", { name: "Device code" }) as HTMLInputElement)
        .value,
    ).toBe("ABCD-1234");
    expect(
      (screen.getByRole("textbox", { name: "Device code" }) as HTMLInputElement)
        .readOnly,
    ).toBe(true);
    const link = screen.getByRole("link", { name: /open it again/i });
    expect(link.getAttribute("href")).toBe(pending.verificationUrl);
    expect(screen.getByRole("button", { name: "Copy device code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeTruthy();
  });

  it("polling calls providerLoginSsoPoll(id, loginId, pollSecret, baseUrl) every 2 s", async () => {
    vi.useFakeTimers();
    mockedOauth.mockResolvedValue(pending);
    mockedPoll.mockResolvedValue(pending);
    renderSection({ authMode: "oauth" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    await advance(0);
    await advance(2000);
    expect(mockedPoll).toHaveBeenCalled();
    expect(mockedPoll).toHaveBeenCalledWith(
      "tama",
      "login-1",
      "secret-1",
      "https://tama.wizards.town/v1",
    );
    await advance(2000);
    expect(mockedPoll).toHaveBeenCalledTimes(2);
  });

  it("an authenticated poll clears the panel, shows the badge and STOPS polling", async () => {
    vi.useFakeTimers();
    mockedOauth.mockResolvedValue(pending);
    mockedPoll.mockResolvedValue(authenticated);
    renderSection({ authMode: "oauth" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    await advance(2000);
    expect(screen.getByText("authenticated")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Device code" }),
    ).toBeNull();
    const calls = mockedPoll.mock.calls.length;
    await advance(10_000);
    expect(mockedPoll).toHaveBeenCalledTimes(calls);
  });

  it("unmounting mid-poll cancels the interval (no poll, no setState after unmount)", async () => {
    vi.useFakeTimers();
    mockedOauth.mockResolvedValue(pending);
    mockedPoll.mockResolvedValue(pending);
    const view = render(
      <ProviderAuthSection
        provider={provider({ authMode: "oauth" })}
        budget={undefined}
        onCommitField={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    // Prove the loop is RUNNING first — otherwise this test would pass for the
    // wrong reason (a poll that never started also "never ran after unmount").
    await advance(2000);
    expect(mockedPoll).toHaveBeenCalledTimes(1);
    view.unmount();
    await advance(10_000);
    expect(mockedPoll).toHaveBeenCalledTimes(1);
  });

  it("the poll's HTTP-400 sentence is TERMINAL: the flow-expired badge, no more polling", async () => {
    vi.useFakeTimers();
    mockedOauth.mockResolvedValue(pending);
    mockedPoll.mockRejectedValue({
      kind: "other",
      message: EXPIRED,
    });
    renderSection({ authMode: "oauth" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    await advance(2000);
    const badge = screen.getByText("flow expired");
    expect(badge.getAttribute("title")).toBe(EXPIRED);
    expect(
      screen.queryByRole("textbox", { name: "Device code" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Sign in Tama",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    const calls = mockedPoll.mock.calls.length;
    await advance(10_000);
    expect(mockedPoll).toHaveBeenCalledTimes(calls);
  });

  it("Cancel stops the poll and closes the panel", async () => {
    vi.useFakeTimers();
    mockedOauth.mockResolvedValue(pending);
    mockedPoll.mockResolvedValue(pending);
    renderSection({ authMode: "oauth" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in Tama" }));
    // Same non-vacuity rule as the unmount case: prove the loop is running
    // before asking Cancel to stop it.
    await advance(2000);
    expect(mockedPoll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(
      screen.queryByRole("textbox", { name: "Device code" }),
    ).toBeNull();
    await advance(10_000);
    expect(mockedPoll).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderAuthSection — the team-choice panel (the chooseTeam step)", () => {
  const chooseTeam: ChooseTeamStep = {
    status: "chooseTeam",
    loginId: "login-1",
    pollSecret: "secret-1",
    teams: [
      { teamId: "team-a", teamAlias: "Platform" },
      { teamId: "team-b", teamAlias: "" },
    ],
  };

  it("a chooseTeam step renders the team list (alias, falling back to the id)", async () => {
    mockedOauth.mockResolvedValue(chooseTeam);
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    fireEvent.click(screen.getByRole("combobox", { name: "Choose a team" }));
    expect(await screen.findByRole("option", { name: "Platform" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "team-b" })).toBeTruthy();
  });

  it("picking a team and Continue calls providerLoginSsoChooseTeam with that teamId", async () => {
    mockedOauth.mockResolvedValue(chooseTeam);
    mockedChoose.mockResolvedValue(authenticated);
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    fireEvent.click(screen.getByRole("combobox", { name: "Choose a team" }));
    fireEvent.click(await screen.findByRole("option", { name: "Platform" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await flush();
    expect(mockedChoose).toHaveBeenCalledWith(
      "tama",
      "login-1",
      "secret-1",
      "https://tama.wizards.town/v1",
      "team-a",
    );
    expect(await screen.findByText("authenticated")).toBeTruthy();
  });

  it("a chooseTeam response to the choice re-renders the list (the flow is not over)", async () => {
    mockedOauth.mockResolvedValue(chooseTeam);
    mockedChoose.mockResolvedValue({ ...chooseTeam, loginId: "login-2" });
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    fireEvent.click(screen.getByRole("combobox", { name: "Choose a team" }));
    fireEvent.click(await screen.findByRole("option", { name: "Platform" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await flush();
    // Still on the team panel (a fresh list, a fresh loginId carried in the step).
    expect(
      screen.getByRole("combobox", { name: "Choose a team" }),
    ).toBeTruthy();
    expect(screen.queryByText("authenticated")).toBeNull();
  });

  it("a rejection on the choice rides describeIpcError", async () => {
    mockedOauth.mockResolvedValue(chooseTeam);
    mockedChoose.mockRejectedValue({ message: "team selection failed: denied" });
    renderSection({ authMode: "oauth" });
    await clickSignIn();
    fireEvent.click(screen.getByRole("combobox", { name: "Choose a team" }));
    fireEvent.click(await screen.findByRole("option", { name: "Platform" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await flush();
    const badge = await screen.findByText("error");
    expect(badge.getAttribute("title")).toBe("team selection failed: denied");
  });
});

describe("ProviderAuthSection — the paste-token fallback", () => {
  it("a pasted token calls providerLoginPasteToken(id, baseUrl, token, true) and shows saved", async () => {
    mockedPaste.mockResolvedValue(authenticated);
    renderSection({ authMode: "oauth" });
    // Queried BY LABEL, not by role: a `type="password"` input exposes no ARIA
    // `textbox` role (measured — `getByRole("textbox")` finds nothing for it),
    // so the password field is only reachable through its accessible name.
    const input = screen.getByLabelText("SSO token");
    fireEvent.change(input, { target: { value: "sk-pasted" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await flush();
    expect(mockedPaste).toHaveBeenCalledWith(
      "tama",
      "https://tama.wizards.town/v1",
      "sk-pasted",
      true,
    );
    expect(await screen.findByText("saved")).toBeTruthy();
    // The draft is a CREDENTIAL: a successful save clears the field.
    expect(
      (screen.getByLabelText("SSO token") as HTMLInputElement).value,
    ).toBe("");
  });

  it("a pasted token NEVER reaches onCommitField (the settings document stays clean)", async () => {
    mockedPaste.mockResolvedValue(authenticated);
    const { onCommitField } = renderSection({ authMode: "oauth" });
    fireEvent.change(screen.getByLabelText("SSO token"), {
      target: { value: "sk-pasted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await flush();
    expect(onCommitField).not.toHaveBeenCalled();
  });

  it("a rejected paste shows its own error badge", async () => {
    mockedPaste.mockRejectedValue({ message: "token storage failed: permission denied" });
    renderSection({ authMode: "oauth" });
    fireEvent.change(screen.getByLabelText("SSO token"), {
      target: { value: "sk-pasted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await flush();
    const badge = await screen.findByText("error");
    expect(badge.getAttribute("title")).toBe(
      "token storage failed: permission denied",
    );
  });

  it("an api_key row renders NO paste affordance", () => {
    renderSection();
    expect(screen.queryByLabelText("SSO token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save token" })).toBeNull();
  });
});

describe("ProviderAuthSection — the settings-document editors", () => {
  it("an api_key row still gets the headers editor and the insecure-HTTP switch", () => {
    renderSection();
    expect(screen.getByRole("textbox", { name: /Headers/ })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Allow insecure HTTP" }),
    ).toBeTruthy();
  });

  it("a headers blur commits the parsed map through onCommitField", () => {
    const { onCommitField } = renderSection();
    const area = screen.getByRole("textbox", { name: /Headers/ });
    fireEvent.change(area, {
      target: { value: "CF-Access-Client-Id=$CF_CLIENT_ID\nX-Team=core" },
    });
    fireEvent.blur(area);
    expect(onCommitField).toHaveBeenCalledWith({
      headers: { "CF-Access-Client-Id": "$CF_CLIENT_ID", "X-Team": "core" },
    });
  });

  it("an unchanged headers blur commits NOTHING (the TextField change-only rule)", () => {
    const { onCommitField } = renderSection({
      headers: { "X-Team": "core" },
    });
    const area = screen.getByRole("textbox", { name: /Headers/ });
    // The draft is SEEDED from the saved map — so the field opens reading
    // `X-Team=core`, and blurring it untouched must not re-save.
    expect((area as HTMLTextAreaElement).value).toBe("X-Team=core");
    fireEvent.blur(area);
    expect(onCommitField).not.toHaveBeenCalled();
  });

  it("clearing the headers commits undefined (the empty map is an ABSENCE)", () => {
    const { onCommitField } = renderSection({ headers: { "X-Team": "core" } });
    const area = screen.getByRole("textbox", { name: /Headers/ });
    fireEvent.change(area, { target: { value: "" } });
    fireEvent.blur(area);
    expect(onCommitField).toHaveBeenCalledWith({ headers: undefined });
  });

  it("the insecure-HTTP switch commits the boolean", () => {
    const { onCommitField } = renderSection();
    fireEvent.click(screen.getByRole("switch", { name: "Allow insecure HTTP" }));
    expect(onCommitField).toHaveBeenCalledWith({ allowInsecureHttp: true });
  });

  it("the oidc block renders ONLY for an oidc row", () => {
    renderSection({ authMode: "oauth" });
    expect(screen.queryByRole("textbox", { name: "OIDC issuer" })).toBeNull();
    cleanup();
    renderSection({ authMode: "oidc" });
    expect(screen.getByRole("textbox", { name: "OIDC issuer" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "OIDC client ID" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "OIDC scope" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "OIDC redirect ports" }),
    ).toBeTruthy();
  });

  it("the oidc fields commit COMPOSED over the existing block (the spread pin)", () => {
    const { onCommitField } = renderSection({
      authMode: "oidc",
      oidc: { issuer: "https://old.test", clientId: "cid" },
    });
    const issuer = screen.getByRole("textbox", { name: "OIDC issuer" });
    fireEvent.change(issuer, { target: { value: "https://idp.test" } });
    fireEvent.blur(issuer);
    expect(onCommitField).toHaveBeenLastCalledWith({
      oidc: { issuer: "https://idp.test", clientId: "cid" },
    });
  });

  it("the redirect-ports field parses the comma list and keeps sibling keys", () => {
    const { onCommitField } = renderSection({
      authMode: "oidc",
      oidc: { issuer: "https://idp.test", scope: "openid email" },
    });
    const ports = screen.getByRole("textbox", { name: "OIDC redirect ports" });
    expect((ports as HTMLInputElement).value).toBe("");
    fireEvent.change(ports, { target: { value: "8420, 8421" } });
    fireEvent.blur(ports);
    expect(onCommitField).toHaveBeenCalledWith({
      oidc: {
        issuer: "https://idp.test",
        scope: "openid email",
        redirectPorts: [8420, 8421],
      },
    });
  });

  it("an empty redirect-ports list commits the EMPTY list (= ephemeral)", () => {
    const { onCommitField } = renderSection({
      authMode: "oidc",
      oidc: { issuer: "https://idp.test", redirectPorts: [8420] },
    });
    const ports = screen.getByRole("textbox", { name: "OIDC redirect ports" });
    expect((ports as HTMLInputElement).value).toBe("8420");
    fireEvent.change(ports, { target: { value: "" } });
    fireEvent.blur(ports);
    expect(onCommitField).toHaveBeenCalledWith({
      oidc: { issuer: "https://idp.test", redirectPorts: [] },
    });
  });
});

describe("ProviderAuthSection — the spend / max-budget line", () => {
  it("a key row with both figures renders them through moneyOf", () => {
    renderSection({}, { budget: [keyRow()] });
    expect(screen.getByText("Spend / max budget")).toBeTruthy();
    expect(screen.getByText("$12.34 / $100.00")).toBeTruthy();
  });

  it("an unlimited key (maxBudget null) renders the spend against 'unlimited'", () => {
    renderSection({}, { budget: [keyRow({ maxBudget: null, remaining: null })] });
    expect(screen.getByText("$12.34 / unlimited")).toBeTruthy();
  });

  it("a row with NO figures renders NOTHING — never $0.00 (moneyOf's rule)", () => {
    renderSection(
      {},
      { budget: [keyRow({ spend: null, maxBudget: null, remaining: null })] },
    );
    expect(screen.queryByText("Spend / max budget")).toBeNull();
    expect(screen.queryByText("$0.00 / $0.00")).toBeNull();
    expect(screen.queryByText(/unlimited/)).toBeNull();
  });

  it("an absent budget (not fetched / fetch failed / no rows) renders NOTHING", () => {
    renderSection({}, { budget: undefined });
    expect(screen.queryByText("Spend / max budget")).toBeNull();
    cleanup();
    renderSection({}, { budget: [] });
    expect(screen.queryByText("Spend / max budget")).toBeNull();
  });

  it("the PRIMARY line is the key row — a user/team-only ledger shows nothing there", () => {
    // The landed bulk shape carries every hop; the spec's display is the KEY
    // hop, and `user`/`team` rows are the multi-hop ledger, not the row's line.
    renderSection(
      {},
      {
        budget: [
          {
            level: "user",
            entitled: true,
            label: "daniel",
            spend: 5,
            maxBudget: 50,
            remaining: 45,
            budgetResetAt: null,
          },
        ],
      },
    );
    expect(screen.queryByText("Spend / max budget")).toBeNull();
  });
});
