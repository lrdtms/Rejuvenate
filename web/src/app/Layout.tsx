/**
 * Layout — shared shell wrapping all public pages.
 * Renders <Header /> + <main> slot + <Footer />.
 */
import { Outlet } from 'react-router-dom';
import { Header } from '@/design-system/Header';
import { Footer } from '@/design-system/Footer';

export function Layout() {
  return (
    <>
      <Header />
      <Outlet />
      <Footer />
    </>
  );
}
