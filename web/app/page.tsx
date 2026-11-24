import Image from "next/image";
import { AppDemo } from "./app-demo";
import { FeatureExplorer, WowFolderDemo } from "./feature-demos";
import { HeroShot, MotionRoot, PressableLink, Reveal, SectionNav, Stagger, StaggerItem } from "./motion";

const REPO_URL = "https://github.com/RobDeFlop/FloorPoV";
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

interface Screenshot {
  src: string;
  alt: string;
}

interface ShowcaseItem {
  title: string;
  body: string;
  screenshot: Screenshot;
}

const VIDEO_ANALYSIS: Screenshot = {
  src: "/screenshots/video-analysis.webp",
  alt: "Video analysis of The Coiled Altar with raid footage, timeline markers, and a timestamped event list",
};

const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    title: "Click an event to watch it",
    body:
      "Every event in the list has a timestamp. Click one and the recording seeks to a few " +
      "seconds before it happened.",
    screenshot: VIDEO_ANALYSIS,
  },
  {
    title: "Count what happened in a pull",
    body:
      "Log analysis reads the same combat log and shows how often each event happened and " +
      "when. Deaths and Bloodlust are two of the things it tracks.",
    screenshot: {
      src: "/screenshots/log-analysis.webp",
      alt: "Log analysis of an encounter with event counts and timestamps for deaths and Bloodlust",
    },
  },
];

const PRIMARY_BUTTON =
  "inline-flex min-h-10 items-center gap-2 rounded-sm border border-emerald-300/35 " +
  "bg-emerald-500/12 px-4 text-sm text-emerald-100";
const SECONDARY_BUTTON =
  "inline-flex min-h-10 items-center rounded-sm border border-white/15 bg-black/20 px-4 " +
  "text-sm text-neutral-300 transition-colors hover:border-emerald-300/40 " +
  "hover:bg-emerald-500/10 hover:text-emerald-100";

function DownloadButton() {
  return (
    <button type="button" disabled className={`${PRIMARY_BUTTON} cursor-not-allowed`}>
      Download for Windows
      <span className="text-xs text-emerald-300/70">coming soon</span>
    </button>
  );
}

function GitHubLink() {
  return (
    <PressableLink href={REPO_URL} className={SECONDARY_BUTTON}>
      Source on GitHub
    </PressableLink>
  );
}

function ScreenshotFrame({ screenshot, priority = false, sizes }: {
  screenshot: Screenshot;
  priority?: boolean;
  sizes: string;
}) {
  return (
    <div className="overflow-hidden rounded-md bg-surface shadow-surface transition-transform duration-300 hover:-translate-y-0.5 hover:outline hover:outline-1 hover:outline-emerald-300/25">
      <Image
        src={screenshot.src}
        alt={screenshot.alt}
        width={1600}
        height={1000}
        priority={priority}
        sizes={sizes}
        className="h-auto w-full"
      />
    </div>
  );
}

const NAV_LINKS = [
  { label: "Screenshots", href: "#screenshots" },
  { label: "Features", href: "#features" },
  { label: "Setup", href: "#setup" },
];

// Matches the brand chip and caption in the desktop app's TitleBar.
function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[rgba(14,14,16,0.85)] px-6 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <a
            href="#top"
            className="group inline-flex items-center gap-2.5 rounded-sm border border-white/15 bg-white/5 px-2.5 py-1.5 transition-colors hover:border-emerald-300/40 hover:bg-emerald-500/10"
          >
            <Image
              src="/floorpov-icon.png"
              alt=""
              width={20}
              height={20}
              priority
              className="size-5 transition-transform duration-700 ease-out group-hover:rotate-[120deg] motion-reduce:transition-none"
            />
            <span className="text-sm font-semibold uppercase tracking-[0.18em] text-neutral-100">
              FloorPoV
            </span>
          </a>
          <span className="hidden h-4 w-px bg-white/15 md:block" />
          <span className="hidden text-[11px] uppercase tracking-[0.14em] text-neutral-500 md:block">
            Gameplay analyzer
          </span>
        </div>
        <div className="flex items-center gap-1">
          <SectionNav links={NAV_LINKS} />
          <a
            href={REPO_URL}
            className="ml-2 inline-flex items-center gap-2 rounded-sm border border-white/15 bg-black/20 px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-neutral-300 transition-colors hover:border-emerald-300/40 hover:bg-emerald-500/10 hover:text-emerald-100"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="px-6 pt-10 sm:pt-14">
      <Stagger onLoad className="mx-auto max-w-7xl">
        <StaggerItem>
          <p className="flex items-center gap-2 text-sm text-neutral-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-300" />
            Beta for Windows 10 and 11
          </p>
        </StaggerItem>
        <StaggerItem>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl font-semibold tracking-tight text-neutral-100 sm:text-6xl">
            Record World of Warcraft with the combat log on the timeline
          </h1>
        </StaggerItem>
        <StaggerItem>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-neutral-400">
            FloorPoV reads your combat log while it records. Deaths, Bloodlust, boss
            encounters, and the markers you set with a hotkey show up on the video, and
            clicking one takes you to that moment. It works for Mythic+, raids, and PvP.
          </p>
        </StaggerItem>
        <StaggerItem className="mt-8 flex flex-wrap items-center gap-3">
          <DownloadButton />
          <GitHubLink />
        </StaggerItem>
      </Stagger>
      <HeroShot className="mx-auto mt-16 max-w-7xl">
        <div className="hidden md:block">
          <AppDemo />
          <p className="mt-4 text-center text-sm text-neutral-500">
            Try it: click an event or the timeline, switch tabs, or press M to add a marker.
          </p>
        </div>
        <div className="md:hidden">
          <ScreenshotFrame screenshot={VIDEO_ANALYSIS} priority sizes="100vw" />
        </div>
      </HeroShot>
    </section>
  );
}

function Screenshots() {
  return (
    <section id="screenshots" className="scroll-mt-20 px-6 py-28">
      <div className="mx-auto flex max-w-7xl flex-col gap-24">
        {SHOWCASE_ITEMS.map((item, idx) => {
          const imageFirst = idx % 2 === 1;
          return (
            <div
              key={item.title}
              className="grid items-center gap-8 lg:grid-cols-[2fr_3fr] lg:gap-14"
            >
              <Reveal className={imageFirst ? "lg:order-2" : undefined}>
                <h2 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">
                  {item.title}
                </h2>
                <p className="mt-4 text-pretty text-lg leading-8 text-neutral-400">{item.body}</p>
              </Reveal>
              <Reveal delay={0.1} className={imageFirst ? "lg:order-1" : undefined}>
                <ScreenshotFrame
                  screenshot={item.screenshot}
                  sizes="(min-width: 1024px) 640px, 100vw"
                />
              </Reveal>
            </div>
          );
        })}
        <Reveal>
          <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-white/15 text-sm text-neutral-500">
            More screenshots soon.
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-white/10 px-6 py-28">
      <div className="mx-auto max-w-7xl">
        <Reveal>
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">
            Features
          </h2>
          <p className="mt-3 text-lg text-neutral-400">Pick a feature to try it.</p>
        </Reveal>
        <Reveal delay={0.1} className="mt-10">
          <FeatureExplorer />
        </Reveal>
      </div>
    </section>
  );
}

function Setup() {
  return (
    <section id="setup" className="scroll-mt-20 border-t border-white/10 px-6 py-28">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <Reveal className="space-y-5 text-lg leading-8 text-neutral-400">
          <h2 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">
            Setup
          </h2>
          <p>
            FloorPoV runs on Windows 10 and 11. FFmpeg and the Node.js parser come with it, so
            you don&apos;t need to install either one.
          </p>
          <p>
            Once it&apos;s installed, pick your World of Warcraft folder in Settings. Combat
            logging has to be on in the game. Detection, automatic recording, and live uploads
            all read{" "}
            <code className="rounded-sm bg-white/5 px-1.5 py-0.5 text-base text-neutral-300">
              Logs\WoWCombatLog*.txt
            </code>
            .
          </p>
          <p className="rounded-sm border border-amber-200/20 bg-amber-200/5 px-4 py-3 text-base leading-7 text-amber-100/80">
            FloorPoV is in beta and some parts are unfinished. If you find a bug you can
            reproduce, please{" "}
            <a href={ISSUES_URL} className="text-amber-200 underline underline-offset-4">
              open an issue
            </a>
            .
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <WowFolderDemo />
          <p className="mt-3 text-sm text-neutral-500">Try Browse to see what Settings shows.</p>
        </Reveal>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="border-t border-white/10 px-6 py-24">
      <Reveal className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
        <p className="text-lg text-neutral-300">
          Downloads aren&apos;t open yet. The code is on GitHub.
        </p>
        <div className="flex flex-wrap gap-3">
          <DownloadButton />
          <GitHubLink />
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10 px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 text-sm text-neutral-500 sm:flex-row">
        <p>FloorPoV is licensed under GPLv3.</p>
        <div className="flex gap-6">
          <a href={REPO_URL} className="transition-colors hover:text-neutral-200">
            GitHub
          </a>
          <a href={ISSUES_URL} className="transition-colors hover:text-neutral-200">
            Issues
          </a>
          <a href={LICENSE_URL} className="transition-colors hover:text-neutral-200">
            License
          </a>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <MotionRoot>
      <Header />
      <main className="flex-1">
        <Hero />
        <Screenshots />
        <Features />
        <Setup />
        <Closing />
      </main>
      <Footer />
    </MotionRoot>
  );
}
