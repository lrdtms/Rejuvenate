/**
 * useDropdownNav — ports the full script.js interaction model into a React hook.
 *
 * Faithfully preserves:
 * - DESKTOP_BREAKPOINT = 820
 * - HOVER_CLOSE_DELAY_MS = 260
 * - Hover-intent pattern (scheduleCloseDropdown / clearCloseTimer) using
 *   useRef for timer ids (NOT useState — timer ids are not render state).
 * - Click-toggles-dropdown, click-outside closes all, Escape closes all.
 * - Mobile hamburger toggle with aria-expanded.
 * - Desktop hover does NOT fire on touch devices (pointerType check).
 * - Resize: collapse mobile menu when viewport widens past breakpoint.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

export const DESKTOP_BREAKPOINT = 820;
export const HOVER_CLOSE_DELAY_MS = 260;

export interface UseDropdownNavReturn {
  /** Whether the mobile nav is open */
  mobileOpen: boolean;
  /** The key of the currently open dropdown (null = none) */
  openDropdown: string | null;
  /** Toggle the mobile nav */
  toggleMobile: () => void;
  /** Close the mobile nav */
  closeMobile: () => void;
  /** Open a named dropdown immediately (clears any pending close timer) */
  openDropdownByKey: (key: string) => void;
  /** Close a named dropdown immediately */
  closeDropdownByKey: (key: string) => void;
  /** Schedule a delayed close for a named dropdown (hover-leave) */
  scheduleClose: (key: string) => void;
  /** Cancel a pending close timer (hover-re-enter) */
  clearCloseTimer: (key: string) => void;
  /** Click handler for a dropdown trigger — toggles and closes others */
  toggleDropdown: (key: string) => void;
}

export function useDropdownNav(dropdownKeys: string[]): UseDropdownNavReturn {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  // Timer ids keyed by dropdown key — useRef so mutations don't trigger re-renders
  const closeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearCloseTimer = useCallback((key: string) => {
    const timer = closeTimers.current[key];
    if (timer !== undefined) {
      clearTimeout(timer);
      delete closeTimers.current[key];
    }
  }, []);

  const openDropdownByKey = useCallback(
    (key: string) => {
      clearCloseTimer(key);
      setOpenDropdown(key);
    },
    [clearCloseTimer],
  );

  const closeDropdownByKey = useCallback(
    (key: string) => {
      clearCloseTimer(key);
      setOpenDropdown((prev) => (prev === key ? null : prev));
    },
    [clearCloseTimer],
  );

  const scheduleClose = useCallback(
    (key: string) => {
      clearCloseTimer(key);
      const timer = setTimeout(() => {
        setOpenDropdown((prev) => (prev === key ? null : prev));
        delete closeTimers.current[key];
      }, HOVER_CLOSE_DELAY_MS);
      closeTimers.current[key] = timer;
    },
    [clearCloseTimer],
  );

  const toggleDropdown = useCallback(
    (key: string) => {
      // Clear any pending close timer for this dropdown
      clearCloseTimer(key);
      setOpenDropdown((prev) => {
        const next = prev === key ? null : key;
        return next;
      });
    },
    [clearCloseTimer],
  );

  const toggleMobile = useCallback(() => {
    setMobileOpen((prev) => !prev);
  }, []);

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
  }, []);

  // Click-outside: close all dropdowns; close mobile nav if click is outside nav
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const inDropdown = target.closest('.has-dropdown');
      if (!inDropdown) {
        // Close all dropdowns
        dropdownKeys.forEach((k) => clearCloseTimer(k));
        setOpenDropdown(null);
      }

      // Close mobile nav if click is outside the nav and outside the toggle
      if (
        !target.closest('.menu-toggle') &&
        !target.closest('.site-nav') &&
        window.innerWidth <= DESKTOP_BREAKPOINT
      ) {
        setMobileOpen(false);
      }
    }

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [dropdownKeys, clearCloseTimer]);

  // Escape key: close all dropdowns and mobile menu
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      dropdownKeys.forEach((k) => {
        clearCloseTimer(k);
      });
      setOpenDropdown(null);
      if (window.innerWidth <= DESKTOP_BREAKPOINT) {
        setMobileOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dropdownKeys, clearCloseTimer]);

  // Resize: collapse mobile menu when viewport widens past breakpoint
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth > DESKTOP_BREAKPOINT) {
        setMobileOpen(false);
        dropdownKeys.forEach((k) => clearCloseTimer(k));
      }
    }

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [dropdownKeys, clearCloseTimer]);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      dropdownKeys.forEach((k) => clearCloseTimer(k));
    };
  }, [dropdownKeys, clearCloseTimer]);

  return {
    mobileOpen,
    openDropdown,
    toggleMobile,
    closeMobile,
    openDropdownByKey,
    closeDropdownByKey,
    scheduleClose,
    clearCloseTimer,
    toggleDropdown,
  };
}
