const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector(".site-nav");
const dropdowns = document.querySelectorAll(".has-dropdown");
const DESKTOP_BREAKPOINT = 820;
const HOVER_CLOSE_DELAY_MS = 260;
const closeTimers = new WeakMap();

function setDropdownState(dropdown, isOpen) {
  dropdown.classList.toggle("open", isOpen);
  const trigger = dropdown.querySelector(".dropdown-toggle");
  if (trigger) {
    trigger.setAttribute("aria-expanded", String(isOpen));
  }
}

function clearCloseTimer(dropdown) {
  const timer = closeTimers.get(dropdown);
  if (timer) {
    window.clearTimeout(timer);
    closeTimers.delete(dropdown);
  }
}

function openDropdown(dropdown) {
  clearCloseTimer(dropdown);
  setDropdownState(dropdown, true);
}

function closeDropdown(dropdown) {
  clearCloseTimer(dropdown);
  setDropdownState(dropdown, false);
}

function scheduleCloseDropdown(dropdown) {
  clearCloseTimer(dropdown);
  const timer = window.setTimeout(() => {
    setDropdownState(dropdown, false);
    closeTimers.delete(dropdown);
  }, HOVER_CLOSE_DELAY_MS);
  closeTimers.set(dropdown, timer);
}

if (menuToggle && siteNav) {
  menuToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

dropdowns.forEach((dropdown) => {
  const trigger = dropdown.querySelector(".dropdown-toggle");

  if (!trigger) {
    return;
  }

  dropdown.addEventListener("mouseenter", () => {
    if (window.innerWidth > DESKTOP_BREAKPOINT) {
      openDropdown(dropdown);
    }
  });

  dropdown.addEventListener("mouseleave", () => {
    if (window.innerWidth > DESKTOP_BREAKPOINT) {
      scheduleCloseDropdown(dropdown);
    }
  });

  trigger.addEventListener("click", (event) => {
    event.preventDefault();

    clearCloseTimer(dropdown);
    const isOpen = !dropdown.classList.contains("open");
    setDropdownState(dropdown, isOpen);

    dropdowns.forEach((item) => {
      if (item !== dropdown) {
        closeDropdown(item);
      }
    });
  });
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const inDropdown = event.target.closest(".has-dropdown");
  const inMenuToggle = event.target.closest(".menu-toggle");

  if (!inDropdown) {
    dropdowns.forEach((dropdown) => {
      closeDropdown(dropdown);
    });
  }

  if (!inMenuToggle && siteNav && !event.target.closest(".site-nav") && window.innerWidth <= 820) {
    siteNav.classList.remove("open");
    if (menuToggle) {
      menuToggle.setAttribute("aria-expanded", "false");
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  dropdowns.forEach((dropdown) => {
    closeDropdown(dropdown);
  });

  if (siteNav && menuToggle && window.innerWidth <= 820) {
    siteNav.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 820 && siteNav && menuToggle) {
    siteNav.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
    dropdowns.forEach((dropdown) => clearCloseTimer(dropdown));
  }
});
