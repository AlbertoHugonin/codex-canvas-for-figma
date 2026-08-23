import {
  ArrowLeft,
  Check,
  Copy,
  Folder,
  Plus,
  Send,
  Settings,
  Square,
  createElement,
  type IconNode
} from "lucide";

type JsonObject = Record<string, unknown>;
type MessageRole = "user" | "agent" | "error";
type ModelChoice = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultEffort: string;
  efforts: Array<{ value: string; description: string }>;
};
type ThreadChoice = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};
type HistoryMessage = { role: "user" | "agent"; text: string };
type AccountState = {
  authenticated: boolean;
  requiresOpenaiAuth: boolean;
  accountType: string;
  email: string;
  planType: string;
};
type AccountChallenge = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};
type AccountOperation = "idle" | "loading" | "starting" | "waiting" | "cancelling" | "logging-out";

const BRIDGE_URL = "ws://localhost:3845";
const iconNodes = {
  "arrow-left": ArrowLeft,
  check: Check,
  copy: Copy,
  folder: Folder,
  plus: Plus,
  send: Send,
  settings: Settings,
  square: Square
} satisfies Record<string, IconNode>;
type IconName = keyof typeof iconNodes;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
}

function makeIcon(name: IconName): SVGElement {
  return createElement(iconNodes[name], {
    width: "16",
    height: "16",
    "stroke-width": "1.8",
    "aria-hidden": "true"
  });
}

function setIcon(container: Element, name: IconName): void {
  container.replaceChildren(makeIcon(name));
}

for (const placeholder of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  const name = placeholder.dataset.icon as IconName;
  if (name in iconNodes) setIcon(placeholder, name);
}

const chatView = byId<HTMLElement>("chat-view");
const settingsView = byId<HTMLElement>("settings-view");
const setupView = byId<HTMLElement>("setup-view");
const workspaceOpen = byId<HTMLButtonElement>("workspace-open");
const workspaceName = byId<HTMLElement>("workspace-name");
const workspaceRootInput = byId<HTMLInputElement>("workspace-root");
const workspaceMode = byId<HTMLElement>("workspace-mode");
const workspaceClear = byId<HTMLButtonElement>("workspace-clear");
const connectionIndicator = byId<HTMLElement>("connection-indicator");
const settingsConnectionDot = byId<HTMLElement>("settings-connection-dot");
const settingsConnectionText = byId<HTMLElement>("settings-connection-text");
const settingsOpen = byId<HTMLButtonElement>("settings-open");
const settingsBack = byId<HTMLButtonElement>("settings-back");
const settingsSave = byId<HTMLButtonElement>("settings-save");
const settingsStatus = byId<HTMLElement>("settings-status");
const threadSelect = byId<HTMLSelectElement>("thread-select");
const newThreadButton = byId<HTMLButtonElement>("new-thread");
const contextBar = byId<HTMLElement>("context-bar");
const messagesNode = byId<HTMLElement>("messages");
const composer = byId<HTMLFormElement>("composer");
const promptInput = byId<HTMLTextAreaElement>("prompt");
const sendButton = byId<HTMLButtonElement>("send");
const sendIconCandidate = sendButton.querySelector<HTMLElement>("[data-icon]");
const tokenInput = byId<HTMLInputElement>("token");
const connectButton = byId<HTMLButtonElement>("connect");
const setupError = byId<HTMLElement>("setup-error");
const modelSelect = byId<HTMLSelectElement>("model-select");
const effortSelect = byId<HTMLSelectElement>("effort-select");
const accountStatus = byId<HTMLElement>("account-status");
const accountLoading = byId<HTMLElement>("account-loading");
const accountSignedOut = byId<HTMLElement>("account-signed-out");
const accountConnect = byId<HTMLButtonElement>("account-connect");
const accountChallengeNode = byId<HTMLElement>("account-challenge");
const accountVerificationLink = byId<HTMLAnchorElement>("account-verification-link");
const accountUserCode = byId<HTMLElement>("account-user-code");
const accountCancel = byId<HTMLButtonElement>("account-cancel");
const accountSignedIn = byId<HTMLElement>("account-signed-in");
const accountIdentity = byId<HTMLElement>("account-identity");
const accountPlan = byId<HTMLElement>("account-plan");
const accountLogout = byId<HTMLButtonElement>("account-logout");
const accountError = byId<HTMLElement>("account-error");

if (!sendIconCandidate) throw new Error("Missing send icon container");
const sendIcon: HTMLElement = sendIconCandidate;

let socket: WebSocket | null = null;
let bridgeToken = "";
let connected = false;
let busy = false;
let switchingThread = false;
let activeAgentMessage: HTMLElement | null = null;
let toolStatus: HTMLElement | null = null;
let latestContext: JsonObject | null = null;
let modelCatalog: ModelChoice[] = [];
let savedModel = "";
let savedEffort = "";
let currentThreadId = "";
let autoSelectionAttempted = false;
let creatingNewConversation = false;
let configuredWorkspaceRoot = "";
let pendingSettingsSave = false;
let currentAccount: AccountState | null = null;
let accountChallenge: AccountChallenge | null = null;
let accountOperation: AccountOperation = "idle";
let accountErrorText = "";
let accountCancelRequested = false;
const messageText = new WeakMap<HTMLElement, string>();

const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high"
};

function showView(view: HTMLElement): void {
  for (const candidate of [chatView, settingsView, setupView]) {
    candidate.classList.toggle("hidden", candidate !== view);
  }
}

function showChat(): void {
  showView(chatView);
  requestAnimationFrame(() => promptInput.focus());
}

function showSettings(): void {
  workspaceRootInput.value = configuredWorkspaceRoot;
  setSettingsStatus("");
  showView(settingsView);
  send({ type: "workspace.get" });
  requestAccountState();
}

function showSetup(error = ""): void {
  setupError.textContent = error;
  tokenInput.value = bridgeToken;
  showView(setupView);
  requestAnimationFrame(() => tokenInput.focus());
}

function setSettingsStatus(text: string, kind = ""): void {
  settingsStatus.textContent = text;
  settingsStatus.className = `settings-status${kind ? ` ${kind}` : ""}`;
}

function setConnection(online: boolean): void {
  connected = online;
  if (!online) {
    currentAccount = null;
    accountChallenge = null;
    accountOperation = "idle";
    accountErrorText = "";
    accountCancelRequested = false;
  }
  const label = online ? "Connected locally" : "Offline";
  connectionIndicator.classList.toggle("online", online);
  settingsConnectionDot.classList.toggle("online", online);
  connectionIndicator.title = label;
  connectionIndicator.setAttribute("aria-label", label);
  settingsConnectionText.textContent = label;
  setControlsDisabled();
}

function setControlsDisabled(): void {
  const accountBlocked = codexControlsBlocked();
  const threadDisabled = !connected || accountBlocked || busy || switchingThread;
  threadSelect.disabled = threadDisabled || !threadSelect.options.length;
  newThreadButton.disabled = threadDisabled;
  workspaceOpen.disabled = !connected || busy;
  settingsOpen.disabled = !connected;
  workspaceRootInput.disabled = !connected || busy;
  workspaceClear.disabled = !connected || busy;
  settingsSave.disabled = !connected || busy;
  modelSelect.disabled = !connected || accountBlocked || busy || !modelCatalog.length;
  effortSelect.disabled = !connected || accountBlocked || busy || !effortSelect.options.length;
  renderAccount();
  updateComposerState();
}

function updateComposerState(): void {
  const accountBlocked = codexControlsBlocked();
  sendButton.disabled = !connected || accountBlocked || (!busy && !promptInput.value.trim());
  promptInput.disabled = !connected || accountBlocked || busy;
  promptInput.placeholder = accountBlocked ? "Connect ChatGPT in Settings" : "Ask Codex...";
  setIcon(sendIcon, busy ? "square" : "send");
  sendButton.title = busy ? "Stop" : "Send";
  sendButton.setAttribute("aria-label", busy ? "Stop" : "Send");
}

function codexControlsBlocked(): boolean {
  if (!connected) return true;
  if (!currentAccount) return true;
  return currentAccount.requiresOpenaiAuth && !currentAccount.authenticated;
}

function displayAccountValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function displayVerificationUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Open sign-in page";
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return "Open sign-in page";
  }
}

function renderAccount(): void {
  const isLoading = connected && accountOperation === "loading";
  const isStarting = accountOperation === "starting";
  const isCancelling = accountOperation === "cancelling";
  const isLoggingOut = accountOperation === "logging-out";
  const showChallenge = connected && Boolean(accountChallenge) && (accountOperation === "waiting" || isCancelling);
  const showSignedIn = connected && !showChallenge && !isLoading && currentAccount?.authenticated === true;
  const showSignedOut = !isLoading && !showChallenge && !showSignedIn;

  accountLoading.hidden = !isLoading;
  accountSignedOut.hidden = !showSignedOut;
  accountChallengeNode.hidden = !showChallenge;
  accountSignedIn.hidden = !showSignedIn;
  accountError.textContent = accountErrorText;

  if (!connected) accountStatus.textContent = "Offline";
  else if (isLoading) accountStatus.textContent = "Checking...";
  else if (isStarting) accountStatus.textContent = "Starting...";
  else if (showChallenge) accountStatus.textContent = isCancelling ? "Cancelling..." : "Waiting for sign-in";
  else if (isLoggingOut) accountStatus.textContent = "Signing out...";
  else if (currentAccount?.authenticated) accountStatus.textContent = "Connected";
  else if (currentAccount?.requiresOpenaiAuth !== false) accountStatus.textContent = "Sign in required";
  else accountStatus.textContent = "Not required";

  accountConnect.disabled = !connected || busy || isStarting;
  accountConnect.textContent = isStarting ? "Starting..." : "Connect ChatGPT";
  accountCancel.disabled = !connected || busy || isCancelling;
  accountCancel.textContent = isCancelling ? "Cancelling..." : "Cancel";
  accountLogout.disabled = !connected || busy || isLoggingOut;
  accountLogout.textContent = isLoggingOut ? "Signing out..." : "Sign out";

  if (accountChallenge) {
    accountVerificationLink.href = accountChallenge.verificationUrl;
    accountVerificationLink.textContent = displayVerificationUrl(accountChallenge.verificationUrl);
    accountVerificationLink.title = accountChallenge.verificationUrl;
    accountUserCode.textContent = accountChallenge.userCode;
  } else {
    accountVerificationLink.removeAttribute("href");
    accountVerificationLink.textContent = "";
    accountVerificationLink.title = "Open ChatGPT sign-in page";
    accountUserCode.textContent = "";
  }

  if (currentAccount?.authenticated) {
    accountIdentity.textContent = currentAccount.email || "ChatGPT";
    const details = [currentAccount.planType, currentAccount.accountType]
      .filter(Boolean)
      .map(displayAccountValue);
    accountPlan.textContent = details.join(" / ") || "Authenticated";
  } else {
    accountIdentity.textContent = "ChatGPT";
    accountPlan.textContent = "";
  }
}

function requestAccountState(): void {
  if (!connected) {
    renderAccount();
    return;
  }
  const interactionInProgress =
    accountOperation === "starting" ||
    accountOperation === "waiting" ||
    accountOperation === "cancelling" ||
    accountOperation === "logging-out";
  if (!interactionInProgress) accountOperation = "loading";
  accountErrorText = "";
  renderAccount();
  setControlsDisabled();
  send({ type: "account.get" });
}

function resizeComposer(): void {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
}

function workspaceLabel(path: string): string {
  if (!path) return "No workspace";
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || path;
}

function applyWorkspaceState(message: JsonObject): void {
  configuredWorkspaceRoot = typeof message.workspaceRoot === "string" ? message.workspaceRoot : "";
  const label = workspaceLabel(configuredWorkspaceRoot);
  workspaceName.textContent = label;
  workspaceOpen.title = configuredWorkspaceRoot || "Open workspace settings";
  workspaceMode.textContent = configuredWorkspaceRoot ? "Writable" : "Figma only";
  workspaceRootInput.value = configuredWorkspaceRoot;
  if (pendingSettingsSave) {
    pendingSettingsSave = false;
    setSettingsStatus("Saved", "success");
  }
}

function saveModelSettings(): void {
  const model = modelSelect.value;
  const effort = effortSelect.value;
  if (!model) return;
  savedModel = model;
  savedEffort = effort;
  parent.postMessage({ pluginMessage: { type: "settings.save-model", model, effort } }, "*");
}

function populateEfforts(preferredEffort = ""): void {
  const model = modelCatalog.find((entry) => entry.id === modelSelect.value);
  effortSelect.replaceChildren();
  for (const effort of model?.efforts ?? []) {
    const option = document.createElement("option");
    option.value = effort.value;
    const suffix = effort.value === model?.defaultEffort ? " - recommended" : "";
    option.textContent = `${effortLabels[effort.value] ?? effort.value}${suffix}`;
    option.title = effort.description;
    effortSelect.appendChild(option);
  }
  const requested = preferredEffort || model?.defaultEffort || "";
  if (Array.from(effortSelect.options).some((option) => option.value === requested)) {
    effortSelect.value = requested;
  }
  setControlsDisabled();
}

function populateModels(message: JsonObject): void {
  const rawModels = Array.isArray(message.models) ? message.models : [];
  modelCatalog = rawModels.filter((entry): entry is ModelChoice => {
    return Boolean(entry && typeof entry === "object" && typeof (entry as ModelChoice).id === "string");
  });
  modelSelect.replaceChildren();
  for (const model of modelCatalog) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.displayName || model.id;
    modelSelect.appendChild(option);
  }
  const requestedModel = savedModel || String(message.selectedModel ?? "");
  const fallbackModel = modelCatalog.find((entry) => entry.isDefault) ?? modelCatalog[0];
  modelSelect.value = modelCatalog.some((entry) => entry.id === requestedModel)
    ? requestedModel
    : (fallbackModel?.id ?? "");
  populateEfforts(savedEffort || String(message.selectedEffort ?? ""));
}

function cleanThreadTitle(thread: ThreadChoice): string {
  const title = String(thread.title || "Untitled conversation").trim();
  const shortened = title.length > 68 ? `${title.slice(0, 65)}...` : title;
  const timestamp = Number(thread.updatedAt || thread.createdAt || 0);
  if (!timestamp) return shortened;
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  if (Number.isNaN(date.getTime())) return shortened;
  return `${shortened} - ${date.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}`;
}

function selectThread(threadId: string): void {
  if (!threadId || !connected || codexControlsBlocked() || busy || switchingThread) return;
  switchingThread = true;
  setControlsDisabled();
  showToolStatus("Loading conversation...");
  send({
    type: "thread.select",
    threadId,
    model: modelSelect.value,
    effort: effortSelect.value
  });
}

function startNewConversation(): void {
  if (!connected || codexControlsBlocked() || busy || switchingThread) return;
  creatingNewConversation = true;
  switchingThread = true;
  setControlsDisabled();
  showToolStatus("Starting conversation...");
  send({ type: "thread.new" });
}

function populateThreads(message: JsonObject): void {
  const rawThreads = Array.isArray(message.threads) ? message.threads : [];
  const threads = rawThreads.filter((entry): entry is ThreadChoice => {
    return Boolean(entry && typeof entry === "object" && typeof (entry as ThreadChoice).id === "string");
  });
  threadSelect.replaceChildren();

  for (const thread of threads) {
    const option = document.createElement("option");
    option.value = thread.id;
    option.textContent = cleanThreadTitle(thread);
    option.title = thread.title || thread.id;
    threadSelect.appendChild(option);
  }

  currentThreadId = typeof message.threadId === "string" ? message.threadId : currentThreadId;
  if (currentThreadId && !threads.some((thread) => thread.id === currentThreadId)) {
    const currentOption = document.createElement("option");
    currentOption.value = currentThreadId;
    currentOption.textContent = "Current conversation";
    threadSelect.appendChild(currentOption);
  }
  if (currentThreadId) threadSelect.value = currentThreadId;
  else threadSelect.selectedIndex = -1;
  setControlsDisabled();

  selectLatestThreadIfAvailable();
}

function selectLatestThreadIfAvailable(): void {
  const latestThreadId = threadSelect.options[0]?.value ?? "";
  if (currentThreadId || creatingNewConversation || autoSelectionAttempted || !latestThreadId) return;
  if (codexControlsBlocked()) return;
  autoSelectionAttempted = true;
  threadSelect.value = latestThreadId;
  selectThread(latestThreadId);
}

function appendInlineMarkdown(parentNode: HTMLElement, text: string): void {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) parentNode.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parentNode.appendChild(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parentNode.appendChild(strong);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (parts) {
        const link = document.createElement("a");
        link.textContent = parts[1];
        link.href = parts[2];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parentNode.appendChild(link);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parentNode.appendChild(document.createTextNode(text.slice(cursor)));
}

function appendTextLines(parentNode: HTMLElement, lines: string[]): void {
  lines.forEach((line, index) => {
    if (index) parentNode.appendChild(document.createElement("br"));
    appendInlineMarkdown(parentNode, line);
  });
}

function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1].trim()) code.dataset.language = fence[1].trim();
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const title = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(title, heading[2]);
      container.appendChild(title);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index++].replace(/^\s*>\s?/, ""));
      }
      const quote = document.createElement("blockquote");
      appendTextLines(quote, quoteLines);
      container.appendChild(quote);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const itemPattern = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(itemPattern);
        if (!item) break;
        const listItem = document.createElement("li");
        appendInlineMarkdown(listItem, item[1]);
        list.appendChild(listItem);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*#{1,3}\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index++]);
    }
    const paragraph = document.createElement("p");
    appendTextLines(paragraph, paragraphLines);
    container.appendChild(paragraph);
  }
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  setIcon(button, "check");
  button.title = "Copied";
  window.setTimeout(() => {
    setIcon(button, "copy");
    button.title = "Copy response";
  }, 1200);
}

function setMessageText(node: HTMLElement, text: string): void {
  messageText.set(node, text);
  const content = node.querySelector<HTMLElement>(".message-content");
  if (!content) return;
  if (node.classList.contains("agent")) renderMarkdown(content, text);
  else content.textContent = text;
}

function showEmpty(): void {
  const empty = document.createElement("div");
  empty.id = "empty";
  empty.className = "empty";
  empty.textContent = "New conversation";
  messagesNode.replaceChildren(empty);
}

function addMessage(role: MessageRole, text = ""): HTMLElement {
  document.getElementById("empty")?.remove();
  const node = document.createElement("div");
  node.className = `message ${role}`;
  const content = document.createElement("div");
  content.className = "message-content";
  node.appendChild(content);
  if (role === "agent") {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "icon-button copy-message";
    copyButton.title = "Copy response";
    copyButton.setAttribute("aria-label", "Copy response");
    copyButton.appendChild(makeIcon("copy"));
    copyButton.addEventListener("click", () => void copyText(messageText.get(node) ?? "", copyButton));
    node.appendChild(copyButton);
  }
  setMessageText(node, text);
  messagesNode.appendChild(node);
  messagesNode.scrollTop = messagesNode.scrollHeight;
  return node;
}

function renderThreadMessages(messages: unknown): void {
  messagesNode.replaceChildren();
  const displayMessages = Array.isArray(messages) ? messages as HistoryMessage[] : [];
  if (!displayMessages.length) {
    showEmpty();
    return;
  }
  for (const message of displayMessages) {
    if ((message.role === "user" || message.role === "agent") && message.text) addMessage(message.role, message.text);
  }
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function showToolStatus(text: string): void {
  if (!toolStatus) {
    toolStatus = document.createElement("div");
    toolStatus.className = "tool-status";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    toolStatus.append(spinner, document.createElement("span"));
    messagesNode.appendChild(toolStatus);
  }
  const label = toolStatus.lastElementChild;
  if (label) label.textContent = text;
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function clearToolStatus(): void {
  toolStatus?.remove();
  toolStatus = null;
}

function bytesToDataUrl(bytes: unknown, mimeType: string): string {
  const view = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(Object.values(bytes as Record<string, number>));
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function send(message: JsonObject): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect(token: string): void {
  bridgeToken = token.trim();
  if (!bridgeToken) {
    showSetup("Enter the token shown by npm start.");
    return;
  }
  autoSelectionAttempted = false;
  creatingNewConversation = false;
  setupError.textContent = "";
  connectButton.disabled = true;
  connectButton.textContent = "Connecting...";
  socket?.close();
  const nextSocket = new WebSocket(BRIDGE_URL);
  socket = nextSocket;

  nextSocket.addEventListener("open", () => send({ type: "auth", token: bridgeToken }));
  nextSocket.addEventListener("message", ({ data }) => {
    if (socket !== nextSocket) return;
    try {
      handleBridgeMessage(JSON.parse(String(data)) as JsonObject);
    } catch (error) {
      addMessage("error", error instanceof Error ? error.message : String(error));
    }
  });
  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;
    setConnection(false);
    connectButton.disabled = false;
    connectButton.textContent = "Connect";
    showSetup("Bridge unavailable. Run npm start in the project.");
  });
  nextSocket.addEventListener("close", (event) => {
    if (socket !== nextSocket) return;
    busy = false;
    switchingThread = false;
    activeAgentMessage = null;
    clearToolStatus();
    setConnection(false);
    connectButton.disabled = false;
    connectButton.textContent = "Connect";
    if (event.code === 4003) showSetup("Invalid token. Copy the one shown by npm start.");
    else if (event.code === 4000) showSetup("Another Figma window connected to the bridge.");
    else showSetup("Bridge disconnected. Run npm start and reconnect.");
  });
}

function submitChatPrompt(text: string): boolean {
  const prompt = text.trim();
  if (!prompt || !connected || codexControlsBlocked() || busy) return false;
  addMessage("user", prompt);
  busy = true;
  activeAgentMessage = null;
  setControlsDisabled();
  send({
    type: "chat.prompt",
    text: prompt,
    model: modelSelect.value,
    effort: effortSelect.value
  });
  return true;
}

function handleBridgeMessage(message: JsonObject): void {
  if (message.type === "auth.ok") {
    currentThreadId = typeof message.threadId === "string" ? message.threadId : "";
    busy = typeof message.turnId === "string" && Boolean(message.turnId);
    parent.postMessage({ pluginMessage: { type: "settings.save-token", token: bridgeToken } }, "*");
    connectButton.disabled = false;
    connectButton.textContent = "Connect";
    setConnection(true);
    showChat();
    requestAccountState();
    send({ type: "context.update", context: latestContext });
    return;
  }

  if (message.type === "account.state") {
    currentAccount = {
      authenticated: message.authenticated === true,
      requiresOpenaiAuth: message.requiresOpenaiAuth !== false,
      accountType: typeof message.accountType === "string" ? message.accountType : "",
      email: typeof message.email === "string" ? message.email : "",
      planType: typeof message.planType === "string" ? message.planType : ""
    };
    if (currentAccount.authenticated) {
      accountChallenge = null;
      accountOperation = "idle";
      accountCancelRequested = false;
    } else if (accountOperation === "loading" || accountOperation === "logging-out") {
      accountOperation = "idle";
    }
    accountErrorText = "";
    setControlsDisabled();
    selectLatestThreadIfAvailable();
    return;
  }

  if (message.type === "account.login.challenge") {
    const loginId = typeof message.loginId === "string" ? message.loginId : "";
    const verificationUrl = typeof message.verificationUrl === "string" ? message.verificationUrl : "";
    const userCode = typeof message.userCode === "string" ? message.userCode : "";
    let safeVerificationUrl = "";
    try {
      const parsed = new URL(verificationUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") safeVerificationUrl = parsed.href;
    } catch {
      safeVerificationUrl = "";
    }
    if (!loginId || !safeVerificationUrl || !userCode) {
      accountChallenge = null;
      accountOperation = "idle";
      accountErrorText = "The bridge returned an invalid sign-in challenge.";
    } else {
      accountChallenge = { loginId, verificationUrl: safeVerificationUrl, userCode };
      accountOperation = "waiting";
      accountErrorText = "";
      accountCancelRequested = false;
    }
    setControlsDisabled();
    return;
  }

  if (message.type === "account.login.completed") {
    const wasCancelled = accountCancelRequested;
    accountCancelRequested = false;
    accountChallenge = null;
    if (wasCancelled) {
      accountOperation = "idle";
      accountErrorText = "";
      requestAccountState();
    } else if (message.success === true) {
      accountOperation = "idle";
      accountErrorText = "";
      requestAccountState();
    } else {
      accountOperation = "idle";
      accountErrorText = typeof message.error === "string" && message.error
        ? message.error
        : "ChatGPT sign-in failed.";
      setControlsDisabled();
    }
    return;
  }

  if (message.type === "models.available") {
    populateModels(message);
    return;
  }

  if (message.type === "workspace.state") {
    applyWorkspaceState(message);
    return;
  }

  if (message.type === "threads.available") {
    populateThreads(message);
    return;
  }

  if (message.type === "thread.ready") {
    currentThreadId = typeof message.threadId === "string" ? message.threadId : "";
    creatingNewConversation = false;
    return;
  }

  if (message.type === "thread.selected") {
    currentThreadId = typeof message.threadId === "string" ? message.threadId : "";
    switchingThread = false;
    creatingNewConversation = false;
    clearToolStatus();
    renderThreadMessages(message.messages);
    threadSelect.value = currentThreadId;
    setControlsDisabled();
    return;
  }

  if (message.type === "thread.reset") {
    currentThreadId = "";
    switchingThread = false;
    if (message.reason === "workspace.changed") {
      creatingNewConversation = false;
      autoSelectionAttempted = false;
    }
    activeAgentMessage = null;
    clearToolStatus();
    threadSelect.selectedIndex = -1;
    showEmpty();
    setControlsDisabled();
    return;
  }

  if (message.type === "agent.delta") {
    clearToolStatus();
    if (!activeAgentMessage) activeAgentMessage = addMessage("agent");
    const nextText = `${messageText.get(activeAgentMessage) ?? ""}${String(message.delta ?? "")}`;
    setMessageText(activeAgentMessage, nextText);
    messagesNode.scrollTop = messagesNode.scrollHeight;
    return;
  }

  if (message.type === "agent.message.started") {
    activeAgentMessage = null;
    return;
  }

  if (message.type === "agent.status") {
    showToolStatus(String(message.text ?? "Working..."));
    return;
  }

  if (message.type === "turn.started") {
    busy = true;
    setControlsDisabled();
    return;
  }

  if (message.type === "turn.completed") {
    busy = false;
    activeAgentMessage = null;
    clearToolStatus();
    setControlsDisabled();
    return;
  }

  if (message.type === "tool.request") {
    parent.postMessage({
      pluginMessage: {
        type: "tool.run",
        requestId: message.requestId,
        tool: message.tool,
        arguments: message.arguments ?? {}
      }
    }, "*");
    return;
  }

  if (message.type === "error") {
    const text = String(message.message ?? "Bridge error");
    if (
      accountOperation === "loading" ||
      accountOperation === "starting" ||
      accountOperation === "cancelling" ||
      accountOperation === "logging-out"
    ) {
      const returnToChallenge = accountOperation === "cancelling" && Boolean(accountChallenge);
      accountOperation = returnToChallenge ? "waiting" : "idle";
      accountCancelRequested = false;
      accountErrorText = text;
      renderAccount();
    }
    pendingSettingsSave = false;
    busy = false;
    switchingThread = false;
    activeAgentMessage = null;
    clearToolStatus();
    threadSelect.value = currentThreadId;
    setControlsDisabled();
    if (!settingsView.classList.contains("hidden")) setSettingsStatus(text, "error");
    else addMessage("error", text);
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data?.pluginMessage as JsonObject | undefined;
  if (!message) return;

  if (message.type === "settings") {
    bridgeToken = typeof message.token === "string" ? message.token : "";
    savedModel = typeof message.model === "string" ? message.model : "";
    savedEffort = typeof message.effort === "string" ? message.effort : "";
    tokenInput.value = bridgeToken;
    if (bridgeToken) connect(bridgeToken);
    else showSetup();
    return;
  }

  if (message.type === "context.selection") {
    latestContext = message.context && typeof message.context === "object"
      ? message.context as JsonObject
      : null;
    const page = latestContext?.page as JsonObject | undefined;
    const selection = Array.isArray(latestContext?.selection) ? latestContext.selection as JsonObject[] : [];
    const pageName = String(page?.name ?? "Page");
    const selectionNames = selection.map((entry) => String(entry.name ?? "Layer"));
    const label = selectionNames.length ? `${pageName} / ${selectionNames.join(", ")}` : `${pageName} / No layer selected`;
    contextBar.textContent = label;
    contextBar.title = label;
    send({ type: "context.update", context: latestContext });
    return;
  }

  if (message.type === "tool.result") {
    let result: unknown = message.result;
    if (result && typeof result === "object") {
      const objectResult = { ...(result as JsonObject) };
      if (objectResult.kind === "image" && objectResult.bytes) {
        objectResult.imageDataUrl = bytesToDataUrl(
          objectResult.bytes,
          String(objectResult.mimeType ?? "image/png")
        );
        delete objectResult.bytes;
      }
      result = objectResult;
    }
    send({
      type: "tool.result",
      requestId: message.requestId,
      ok: message.ok !== false,
      result,
      error: message.error
    });
  }
});

workspaceOpen.addEventListener("click", showSettings);
settingsOpen.addEventListener("click", showSettings);
settingsBack.addEventListener("click", showChat);
workspaceClear.addEventListener("click", () => {
  workspaceRootInput.value = "";
  workspaceRootInput.focus();
});
settingsSave.addEventListener("click", () => {
  if (!connected || busy) return;
  pendingSettingsSave = true;
  setSettingsStatus("Saving...");
  saveModelSettings();
  send({ type: "workspace.set", workspaceRoot: workspaceRootInput.value.trim() });
});
modelSelect.addEventListener("change", () => populateEfforts(effortSelect.value));
accountConnect.addEventListener("click", () => {
  if (!connected || busy || accountOperation !== "idle") return;
  accountOperation = "starting";
  accountErrorText = "";
  setControlsDisabled();
  send({ type: "account.login.start" });
});
accountCancel.addEventListener("click", () => {
  if (!connected || busy || !accountChallenge || accountOperation !== "waiting") return;
  accountOperation = "cancelling";
  accountCancelRequested = true;
  accountErrorText = "";
  setControlsDisabled();
  send({ type: "account.login.cancel", loginId: accountChallenge.loginId });
});
accountLogout.addEventListener("click", () => {
  if (!connected || busy || !currentAccount?.authenticated || accountOperation !== "idle") return;
  accountOperation = "logging-out";
  accountErrorText = "";
  setControlsDisabled();
  send({ type: "account.logout" });
});
accountVerificationLink.addEventListener("click", (event) => {
  event.preventDefault();
  const url = accountChallenge?.verificationUrl;
  if (!url) return;
  parent.postMessage({ pluginMessage: { type: "external.open", url } }, "*");
});
newThreadButton.addEventListener("click", startNewConversation);
threadSelect.addEventListener("change", () => selectThread(threadSelect.value));
connectButton.addEventListener("click", () => connect(tokenInput.value));
tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connect(tokenInput.value);
});
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) {
    send({ type: "chat.interrupt" });
    return;
  }
  const text = promptInput.value;
  if (submitChatPrompt(text)) {
    promptInput.value = "";
    resizeComposer();
    updateComposerState();
  }
});
promptInput.addEventListener("input", () => {
  resizeComposer();
  updateComposerState();
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

setConnection(false);
resizeComposer();
parent.postMessage({ pluginMessage: { type: "ui.ready" } }, "*");
