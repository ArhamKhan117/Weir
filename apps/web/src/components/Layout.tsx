import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from "react-router";

import { DEMO_PLAN_ID, DEPLOYMENT, IS_TESTNET, NETWORK, SITE_URL } from "../lib/config";
import { InstallApp } from "./InstallApp";
import { NetworkSwitch } from "./NetworkSwitch";
import { Toaster } from "./Toaster";
import { Mark, Wordmark } from "./Logo";

const NAV: { to: string; label: string }[] = [
  { to: "/payments", label: "Your payments" },
  { to: "/support", label: "Family support" },
  { to: "/dashboard", label: "For businesses" },
];

/** Where "Try a checkout" goes: the demo plan when one is configured, otherwise the business side. */
export const TRY_HREF = DEMO_PLAN_ID === undefined ? "/dashboard" : `/c/${DEMO_PLAN_ID}`;

/** The page's name for the browser tab: "Weir" at home, "Weir - <page>" everywhere else. */
function pageName(path: string): string | undefined {
  if (path === "/") return undefined;
  if (path.startsWith("/c/")) return "Checkout";
  if (path.startsWith("/s/")) return "Family support";
  return NAV.find((item) => path === item.to)?.label ?? "Not found";
}

function useTabTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const name = pageName(pathname);
    document.title = name === undefined ? "Weir" : `Weir - ${name}`;
  }, [pathname]);
}

export function Layout() {
  useTabTitle();
  const { pathname } = useLocation();
  return (
    <>
      <Header />
      <main>
        {pathname === "/" ? null : (
          <div className="container install-slot">
            <InstallApp />
          </div>
        )}
        <Outlet />
      </main>
      <Footer />
      <Toaster />
      <ScrollRestoration />
    </>
  );
}

/**
 * The site's header. On the home page it floats clear over the photograph, white, and frosts once
 * the page scrolls; everywhere else it is frosted paper from the start. Below tablet width the
 * sections move into a dark sheet that slides down from the top.
 */
function Header() {
  const { pathname } = useLocation();
  const overHero = pathname === "/";
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A route change closes the menu and starts the new page at its top.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <>
      <header className="site-header" data-scrolled={scrolled} data-over-hero={overHero} data-menu={menuOpen}>
        <div className="container header-row">
          <Link to="/" aria-label="Weir home">
            <Wordmark />
          </Link>
          <nav className="site-nav" aria-label="Main">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="header-end">
            <NetworkSwitch />
            <Link className="header-cta" to={TRY_HREF}>
              Try a checkout
            </Link>
            <button
              type="button"
              className="menu-button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MenuIcon open={menuOpen} />
            </button>
          </div>
        </div>
      </header>

      {menuOpen ? <button type="button" className="menu-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}
      <div className="menu-sheet" data-open={menuOpen} aria-hidden={!menuOpen}>
        <nav aria-label="Main">
          <NavLink to="/" end tabIndex={menuOpen ? 0 : -1}>
            Home
          </NavLink>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} tabIndex={menuOpen ? 0 : -1}>
              {item.label}
            </NavLink>
          ))}
          <Link className="header-cta" to={TRY_HREF} tabIndex={menuOpen ? 0 : -1}>
            Try a checkout
          </Link>
          <NetworkSwitch tabIndex={menuOpen ? 0 : -1} />
        </nav>
      </div>
    </>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      {open ? (
        <path d="M5.5 5.5l11 11M16.5 5.5l-11 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path d="M3.5 7h15M3.5 11h15M3.5 15h15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Footer() {
  const explorer = NETWORK.chain.blockExplorers?.default.url;
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <Mark size={26} />
            <p className="footer-blurb">Direct debit for digital dollars. Your money stays yours until it is due.</p>
          </div>
          <FooterColumn title="Use Weir">
            <Link to="/payments">Your payments</Link>
            <Link to="/support">Family support</Link>
            <Link to="/dashboard">For businesses</Link>
          </FooterColumn>
          <FooterColumn title="Check it">
            <a href={`${explorer}/address/${DEPLOYMENT.contracts.MandateHub}`} target="_blank" rel="noreferrer">
              The contract
            </a>
            <a href={`${explorer}/address/${DEPLOYMENT.contracts.MandateCharger}`} target="_blank" rel="noreferrer">
              The charger
            </a>
            {SITE_URL !== undefined ? (
              <a href={SITE_URL} target="_blank" rel="noreferrer">
                About Weir
              </a>
            ) : null}
          </FooterColumn>
          <FooterColumn title="Built on Monad">
            <span>
              Every limit lives in a contract with no owner and no fee. Charges settle on {NETWORK.label} in under a second.
            </span>
          </FooterColumn>
        </div>
        <div className="footer-base">
          <span>Weir, 2026</span>
          <span>{IS_TESTNET ? "On Monad Testnet" : "Live on Monad Mainnet"}</span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div className="footer-col">
      <h4>{title}</h4>
      <ul>
        {items.filter(Boolean).map((child, i) => (
          <li key={i}>{child}</li>
        ))}
      </ul>
    </div>
  );
}
