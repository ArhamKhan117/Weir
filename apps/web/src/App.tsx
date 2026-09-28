import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

import { Layout } from "./components/Layout";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { AccountProvider } from "./passkey/AccountProvider";

// The landing page is the first thing most people see, so it carries no chain client and no
// crypto. Checkout and payments load theirs with the page; the business dashboard carries Privy,
// which payers never download.
const Checkout = lazy(() => import("./pages/Checkout").then((module) => ({ default: module.Checkout })));
const Payments = lazy(() => import("./pages/Payments").then((module) => ({ default: module.Payments })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((module) => ({ default: module.Dashboard })));
const SupportStart = lazy(() => import("./pages/Support").then((module) => ({ default: module.SupportStart })));
const SupportPage = lazy(() => import("./pages/Support").then((module) => ({ default: module.SupportPage })));

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="page-narrow" aria-busy="true" />}>{children}</Suspense>;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Landing /> },
      {
        path: "/c/:planId",
        element: (
          <Page>
            <Checkout />
          </Page>
        ),
      },
      {
        path: "/payments",
        element: (
          <Page>
            <Payments />
          </Page>
        ),
      },
      {
        path: "/support",
        element: (
          <Page>
            <SupportStart />
          </Page>
        ),
      },
      {
        path: "/s/:id",
        element: (
          <Page>
            <SupportPage />
          </Page>
        ),
      },
      {
        path: "/dashboard",
        element: (
          <Page>
            <Dashboard />
          </Page>
        ),
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <AccountProvider>
      <RouterProvider router={router} />
    </AccountProvider>
  );
}
