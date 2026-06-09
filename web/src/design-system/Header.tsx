/**
 * Header — sticky site header with logo, desktop nav (hover dropdowns),
 * and mobile hamburger toggle.
 *
 * Interaction model ported faithfully from script.js:
 * - DESKTOP_BREAKPOINT / HOVER_CLOSE_DELAY_MS constants (820 / 260ms)
 * - Hover-intent: mouseenter opens immediately, mouseleave schedules delayed
 *   close; re-entering cancels the timer. Touch devices skip hover handling
 *   (pointerType === 'mouse' guard).
 * - Click toggle on dropdown trigger; clicking outside closes all; Escape closes all.
 * - aria-expanded / aria-haspopup on every dropdown trigger.
 * - Keyboard: Tab/Enter/Escape all work; focus-within CSS keeps submenu visible
 *   while focus is inside it.
 */
import { NavLink, Link } from 'react-router-dom';
import { useDropdownNav, DESKTOP_BREAKPOINT } from './useDropdownNav';
import logoSrc from '../assets/rejuvenateLogo.svg';
import './Header.css';

const DROPDOWN_KEYS = ['locations'] as const;
type DropdownKey = (typeof DROPDOWN_KEYS)[number];

export function Header() {
  const {
    mobileOpen,
    openDropdown,
    toggleMobile,
    openDropdownByKey,
    scheduleClose,
    clearCloseTimer,
    toggleDropdown,
  } = useDropdownNav([...DROPDOWN_KEYS]);

  function handleMouseEnter(key: DropdownKey) {
    return (e: React.MouseEvent) => {
      // Skip hover on touch (pointer type is not 'mouse')
      if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return;
      if (window.innerWidth > DESKTOP_BREAKPOINT) {
        openDropdownByKey(key);
      }
    };
  }

  function handleMouseLeave(key: DropdownKey) {
    return (e: React.MouseEvent) => {
      if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return;
      if (window.innerWidth > DESKTOP_BREAKPOINT) {
        scheduleClose(key);
      }
    };
  }

  function handleSubmenuMouseEnter(key: DropdownKey) {
    return () => {
      clearCloseTimer(key);
    };
  }

  function handleSubmenuMouseLeave(key: DropdownKey) {
    return () => {
      if (window.innerWidth > DESKTOP_BREAKPOINT) {
        scheduleClose(key);
      }
    };
  }

  const locationsOpen = openDropdown === 'locations';

  return (
    <header className="site-header">
      <Link className="brand" to="/">
        <img className="brand-logo" src={logoSrc} alt="Rejuvenate logo" />
        <span>Rejuvenate</span>
      </Link>

      <button
        className="menu-toggle"
        type="button"
        aria-expanded={mobileOpen}
        aria-controls="primary-nav"
        aria-label="Toggle menu"
        onClick={toggleMobile}
      >
        <span />
        <span />
        <span />
      </button>

      <nav
        id="primary-nav"
        className={`site-nav${mobileOpen ? ' open' : ''}`}
        aria-label="Primary navigation"
      >
        <ul className="menu">
          <li>
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to="/"
              end
            >
              Home
            </NavLink>
          </li>
          <li>
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to="/about"
            >
              About
            </NavLink>
          </li>

          {/* Locations dropdown */}
          <li
            className={`has-dropdown${locationsOpen ? ' open' : ''}`}
            onMouseEnter={handleMouseEnter('locations')}
            onMouseLeave={handleMouseLeave('locations')}
          >
            <button
              className={`dropdown-toggle nav-link${locationsOpen ? ' active' : ''}`}
              type="button"
              aria-expanded={locationsOpen}
              aria-haspopup="true"
              aria-controls="locations-submenu"
              onClick={() => toggleDropdown('locations')}
            >
              Locations
            </button>
            <ul
              id="locations-submenu"
              className="submenu"
              aria-label="Locations submenu"
              onMouseEnter={handleSubmenuMouseEnter('locations')}
              onMouseLeave={handleSubmenuMouseLeave('locations')}
            >
              <li>
                <NavLink
                  className={({ isActive }) => (isActive ? 'active-city' : undefined)}
                  to="/cape-town"
                >
                  Cape Town
                </NavLink>
              </li>
              <li>
                <NavLink
                  className={({ isActive }) => (isActive ? 'active-city' : undefined)}
                  to="/durban"
                >
                  Durban
                </NavLink>
              </li>
            </ul>
          </li>

          <li>
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to="/blog"
            >
              Blog
            </NavLink>
          </li>
          <li>
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to="/events"
            >
              Events
            </NavLink>
          </li>
          <li>
            <NavLink
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              to="/contact"
            >
              Contact
            </NavLink>
          </li>
        </ul>
      </nav>
    </header>
  );
}
