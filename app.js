(() => {
  "use strict";

  const STATUS_LABELS = {
    inbox: "Inbox",
    next: "Next",
    waiting: "Waiting",
    done: "Done"
  };

  const state = {
    client: null,
    session: null,
    profile: null,
    household: null,
    members: [],
    tasks: [],
    activeStatus: "inbox",
    channel: null,
    installPrompt: null,
    updateTimers: new Map(),
    refreshTimer: null
  };

  const el = {
    configurationScreen: document.querySelector("#configuration-screen"),
    loadingScreen: document.querySelector("#loading-screen"),
    setupScreen: document.querySelector("#setup-screen"),
    appScreen: document.querySelector("#app-screen"),
    createHouseholdForm: document.querySelector("#create-household-form"),
    creatorName: document.querySelector("#creator-name"),
    householdName: document.querySelector("#household-name"),
    joinHouseholdForm: document.querySelector("#join-household-form"),
    joinerName: document.querySelector("#joiner-name"),
    joinCode: document.querySelector("#join-code"),
    setupMessage: document.querySelector("#setup-message"),
    householdLabel: document.querySelector("#household-label"),
    newTaskForm: document.querySelector("#new-task-form"),
    newTaskTitle: document.querySelector("#new-task-title"),
    statusTabs: document.querySelector("#status-tabs"),
    taskList: document.querySelector("#task-list"),
    taskTemplate: document.querySelector("#task-template"),
    emptyState: document.querySelector("#empty-state"),
    appMessage: document.querySelector("#app-message"),
    householdButton: document.querySelector("#household-button"),
    householdDialog: document.querySelector("#household-dialog"),
    dialogHouseholdName: document.querySelector("#dialog-household-name"),
    dialogJoinCode: document.querySelector("#dialog-join-code"),
    copyCodeButton: document.querySelector("#copy-code-button"),
    memberList: document.querySelector("#member-list"),
    installButton: document.querySelector("#install-button")
  };

  function showScreen(screen) {
    [
      el.configurationScreen,
      el.loadingScreen,
      el.setupScreen,
      el.appScreen
    ].forEach((item) => item.classList.add("hidden"));

    screen.classList.remove("hidden");
  }

  function setMessage(node, text = "", isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);
  }

  function getErrorMessage(error) {
    return error?.message || "Something went wrong.";
  }

  function configIsReady() {
    const config = window.APP_CONFIG || {};
    return (
      config.supabaseUrl &&
      config.supabasePublishableKey &&
      !config.supabaseUrl.includes("PASTE_") &&
      !config.supabasePublishableKey.includes("PASTE_")
    );
  }

async function initialize() {
  bindEvents();
  registerServiceWorker();

  if (!configIsReady()) {
    showScreen(el.configurationScreen);
    return;
  }

  state.client = window.supabase.createClient(
    window.APP_CONFIG.supabaseUrl,
    window.APP_CONFIG.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    }
  );

  const { data, error } = await state.client.auth.getSession();

  if (error) {
    showScreen(el.setupScreen);
    setMessage(el.setupMessage, getErrorMessage(error), true);
    return;
  }

  if (data.session) {
    await handleSession(data.session);
    return;
  }

  const anonymousResult = await state.client.auth.signInAnonymously();

  if (anonymousResult.error) {
    showScreen(el.setupScreen);
    setMessage(
      el.setupMessage,
      `Direct access could not start: ${getErrorMessage(anonymousResult.error)}`,
      true
    );
    return;
  }

  await handleSession(anonymousResult.data.session);
}

async function handleSession(session) {
  state.session = session;

  if (!session) {
    const anonymousResult = await state.client.auth.signInAnonymously();

    if (anonymousResult.error) {
      showScreen(el.setupScreen);
      setMessage(el.setupMessage, getErrorMessage(anonymousResult.error), true);
      return;
    }

    state.session = anonymousResult.data.session;
  }

  showScreen(el.loadingScreen);
  await loadWorkspace();
}

  function clearWorkspace() {
    if (state.channel && state.client) {
      state.client.removeChannel(state.channel);
    }

    state.profile = null;
    state.household = null;
    state.members = [];
    state.tasks = [];
    state.channel = null;
  }

  async function loadWorkspace() {
    const { data: profile, error: profileError } = await state.client
      .from("profiles")
      .select("user_id, household_id, display_name")
      .eq("user_id", state.session.user.id)
      .maybeSingle();

    if (profileError) {
      setMessage(el.setupMessage, getErrorMessage(profileError), true);
      showScreen(el.setupScreen);
      return;
    }

    if (!profile) {
      showScreen(el.setupScreen);
      return;
    }

    state.profile = profile;

    const [householdResult, membersResult] = await Promise.all([
      state.client
        .from("households")
        .select("id, name, join_code")
        .eq("id", profile.household_id)
        .single(),
      state.client
        .from("profiles")
        .select("user_id, display_name")
        .eq("household_id", profile.household_id)
        .order("created_at", { ascending: true })
    ]);

    if (householdResult.error || membersResult.error) {
      setMessage(
        el.appMessage,
        getErrorMessage(householdResult.error || membersResult.error),
        true
      );
      showScreen(el.appScreen);
      return;
    }

    state.household = householdResult.data;
    state.members = membersResult.data || [];

    renderHousehold();
    showScreen(el.appScreen);
    await loadTasks();
    subscribeToTasks();
  }

  async function loadTasks() {
    if (!state.household) return;

    const { data, error } = await state.client
      .from("tasks")
      .select("id, household_id, title, notes, status, owner_id, created_at, updated_at")
      .eq("household_id", state.household.id)
      .order("updated_at", { ascending: false });

    if (error) {
      setMessage(el.appMessage, getErrorMessage(error), true);
      return;
    }

    state.tasks = data || [];
    setMessage(el.appMessage);
    renderTasks();
  }

  function subscribeToTasks() {
    if (state.channel) {
      state.client.removeChannel(state.channel);
    }

    state.channel = state.client
      .channel(`household-tasks-${state.household.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `household_id=eq.${state.household.id}`
        },
        () => queueRefresh()
      )
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" && error) {
          setMessage(el.appMessage, `Live sync: ${getErrorMessage(error)}`, true);
        }
      });
  }

  function queueRefresh() {
    window.clearTimeout(state.refreshTimer);

    state.refreshTimer = window.setTimeout(async () => {
      const activeTask = document.activeElement?.closest?.(".task-card");
      if (activeTask) {
        queueRefresh();
        return;
      }
      await loadTasks();
    }, 350);
  }

  function renderHousehold() {
    el.householdLabel.textContent = "Stop Re-Remembering";
    el.dialogHouseholdName.textContent = "Adulting";
    el.dialogJoinCode.textContent = state.household.join_code;

    el.memberList.replaceChildren();
    state.members.forEach((member) => {
      const item = document.createElement("li");
      item.textContent =
        member.user_id === state.profile.user_id
          ? `${member.display_name} (you)`
          : member.display_name;
      el.memberList.append(item);
    });
  }

  function renderTasks() {
    const counts = { inbox: 0, next: 0, waiting: 0, done: 0 };

    state.tasks.forEach((task) => {
      if (counts[task.status] !== undefined) counts[task.status] += 1;
    });

    Object.entries(counts).forEach(([status, count]) => {
      const countNode = document.querySelector(`[data-count="${status}"]`);
      if (countNode) countNode.textContent = String(count);
    });

    el.taskList.replaceChildren();

    const visibleTasks = state.tasks.filter(
      (task) => task.status === state.activeStatus
    );

    visibleTasks.forEach((task) => {
      el.taskList.append(createTaskCard(task));
    });

    el.emptyState.textContent = `Nothing in ${STATUS_LABELS[
      state.activeStatus
    ].toLowerCase()}.`;
    el.emptyState.classList.toggle("hidden", visibleTasks.length > 0);
  }

  function createTaskCard(task) {
    const fragment = el.taskTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".task-card");
    const completeButton = fragment.querySelector(".complete-button");
    const titleInput = fragment.querySelector(".task-title");
    const ownerSelect = fragment.querySelector(".task-owner");
    const statusSelect = fragment.querySelector(".task-status");
    const notesInput = fragment.querySelector(".task-notes");
    const deleteButton = fragment.querySelector(".delete-button");
    const expandButton = fragment.querySelector(".expand-button");
    const saveState = fragment.querySelector(".save-state");

    card.dataset.id = task.id;
    card.classList.toggle("is-done", task.status === "done");

    titleInput.value = task.title;
    notesInput.value = task.notes || "";
    statusSelect.value = task.status;
    completeButton.textContent = task.status === "done" ? "✓" : "○";
    completeButton.setAttribute(
      "aria-label",
      task.status === "done" ? "Reopen task" : "Mark task done"
    );

    addOwnerOptions(ownerSelect, task.owner_id);

    titleInput.addEventListener("input", () => {
      scheduleTaskUpdate(task.id, { title: titleInput.value.trim() }, saveState);
    });

    titleInput.addEventListener("blur", () => {
      if (!titleInput.value.trim()) {
        titleInput.value = task.title;
        setCardState(saveState, "A task needs a title.", true);
      }
    });

    notesInput.addEventListener("input", () => {
      scheduleTaskUpdate(task.id, { notes: notesInput.value }, saveState);
    });

    ownerSelect.addEventListener("change", () => {
      updateTask(
        task.id,
        { owner_id: ownerSelect.value || null },
        saveState
      );
    });

    statusSelect.addEventListener("change", () => {
      updateTask(task.id, { status: statusSelect.value }, saveState);
    });

    completeButton.addEventListener("click", () => {
      const status = task.status === "done" ? "inbox" : "done";
      updateTask(task.id, { status }, saveState);
    });

    expandButton.addEventListener("click", () => {
      const isCollapsed = card.classList.toggle("is-collapsed");
      expandButton.setAttribute("aria-expanded", String(!isCollapsed));
      expandButton.textContent = isCollapsed ? "Details" : "Hide";
    });

    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`Delete “${task.title}”?`);
      if (!confirmed) return;

      const { error } = await state.client
        .from("tasks")
        .delete()
        .eq("id", task.id);

      if (error) {
        setCardState(saveState, getErrorMessage(error), true);
      }
    });

    return fragment;
  }

  function addOwnerOptions(select, ownerId) {
    const eitherOption = document.createElement("option");
    eitherOption.value = "";
    eitherOption.textContent = "Either of us";
    select.append(eitherOption);

    state.members.forEach((member) => {
      const option = document.createElement("option");
      option.value = member.user_id;
      option.textContent =
        member.user_id === state.profile.user_id
          ? `${member.display_name} (me)`
          : member.display_name;
      select.append(option);
    });

    select.value = ownerId || "";
  }

  function scheduleTaskUpdate(taskId, patch, saveState) {
    const existingTimer = state.updateTimers.get(taskId);
    window.clearTimeout(existingTimer);

    setCardState(saveState, "Saving…");

    const timer = window.setTimeout(() => {
      state.updateTimers.delete(taskId);
      updateTask(taskId, patch, saveState);
    }, 500);

    state.updateTimers.set(taskId, timer);
  }

  async function updateTask(taskId, patch, saveState) {
    if ("title" in patch && !patch.title) {
      setCardState(saveState, "A task needs a title.", true);
      return;
    }

    setCardState(saveState, "Saving…");

    const { error } = await state.client
      .from("tasks")
      .update(patch)
      .eq("id", taskId);

    if (error) {
      setCardState(saveState, getErrorMessage(error), true);
      return;
    }

    setCardState(saveState, "Saved");
  }

  function setCardState(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);

    if (text === "Saved") {
      window.setTimeout(() => {
        if (node.textContent === "Saved") node.textContent = "";
      }, 900);
    }
  }

  function bindEvents() {

    el.createHouseholdForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(el.setupMessage, "Creating household…");

      const { data, error } = await state.client.rpc("create_household", {
        p_display_name: el.creatorName.value.trim(),
        p_household_name: el.householdName.value.trim()
      });

      if (error) {
        setMessage(el.setupMessage, getErrorMessage(error), true);
        return;
      }

      const result = Array.isArray(data) ? data[0] : data;
      setMessage(
        el.setupMessage,
        `Created. Your invite code is ${result?.join_code || "available inside the app"}.`
      );
      await loadWorkspace();
    });

    el.joinHouseholdForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(el.setupMessage, "Joining household…");

      const { error } = await state.client.rpc("join_household", {
        p_display_name: el.joinerName.value.trim(),
        p_join_code: el.joinCode.value.trim().toUpperCase()
      });

      if (error) {
        setMessage(el.setupMessage, getErrorMessage(error), true);
        return;
      }

      await loadWorkspace();
    });

    el.newTaskForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = el.newTaskTitle.value.trim();
      if (!title) return;

      el.newTaskTitle.disabled = true;

      const initialStatus =
        state.activeStatus === "done" ? "inbox" : state.activeStatus;

      const { error } = await state.client.from("tasks").insert({
        household_id: state.household.id,
        title,
        notes: "",
        status: initialStatus,
        owner_id: null
      });

      el.newTaskTitle.disabled = false;

      if (error) {
        setMessage(el.appMessage, getErrorMessage(error), true);
        return;
      }

      el.newTaskTitle.value = "";
      el.newTaskTitle.focus();

      if (state.activeStatus === "done") {
        state.activeStatus = "inbox";
        updateActiveTab();
      }
    });

    el.statusTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-status]");
      if (!button) return;
      state.activeStatus = button.dataset.status;
      updateActiveTab();
      renderTasks();
    });

    el.householdButton.addEventListener("click", () => {
      el.householdDialog.showModal();
    });

    el.copyCodeButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.household.join_code);
        el.copyCodeButton.textContent = "Copied";
        window.setTimeout(() => {
          el.copyCodeButton.textContent = "Copy";
        }, 1200);
      } catch {
        window.prompt("Copy this invite code:", state.household.join_code);
      }
    });
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      el.installButton.classList.remove("hidden");
    });

    el.installButton.addEventListener("click", async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      el.installButton.classList.add("hidden");
    });
  }

  function updateActiveTab() {
    el.statusTabs.querySelectorAll("button[data-status]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.status === state.activeStatus
      );
    });
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch(() => {
          // The app still works without installation/offline shell support.
        });
      });
    }
  }

  initialize();
})();
