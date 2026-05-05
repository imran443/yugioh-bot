"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useDraftWebsocket } from "@/lib/hooks/use-draft-websocket";
import { CardGrid } from "@/components/draft/card-grid";
import { TimerBar } from "@/components/draft/timer-bar";
import { SeatList } from "@/components/draft/seat-list";
import { PoolPanel } from "@/components/draft/pool-panel";

// Mock data for development until real draft engine is wired (Task 13)
const MOCK_CARDS = [
  {
    id: 1,
    name: "Dark Magician",
    type: "Spellcaster Monster",
    frameType: "normal",
    attribute: "DARK",
    level: 7,
    effectText:
      "The ultimate wizard in terms of attack and defense. A spellcaster of great power and wisdom.",
    atk: 2500,
    def: 2100,
    imageUrl: "https://images.ygoprodeck.com/images/cards/46986414.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/46986414.jpg",
  },
  {
    id: 2,
    name: "Blue-Eyes White Dragon",
    type: "Dragon Monster",
    frameType: "normal",
    attribute: "LIGHT",
    level: 8,
    effectText:
      "This legendary dragon is a powerful engine of destruction. Virtually invincible, very few have faced this awesome creature and lived to tell the tale.",
    atk: 3000,
    def: 2500,
    imageUrl: "https://images.ygoprodeck.com/images/cards/89631139.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/89631139.jpg",
  },
  {
    id: 3,
    name: "Pot of Greed",
    type: "Spell",
    frameType: "spell",
    effectText: "Draw 2 cards.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/55144522.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/55144522.jpg",
  },
  {
    id: 4,
    name: "Mirror Force",
    type: "Trap",
    frameType: "trap",
    effectText:
      "When an opponent's monster declares an attack: Destroy all your opponent's Attack Position monsters.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/44095762.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/44095762.jpg",
  },
  {
    id: 5,
    name: "Red-Eyes Black Dragon",
    type: "Dragon Monster",
    frameType: "normal",
    attribute: "DARK",
    level: 7,
    effectText:
      "A ferocious dragon with a deadly attack. Its red eyes are said to glow with an eerie light.",
    atk: 2400,
    def: 2000,
    imageUrl: "https://images.ygoprodeck.com/images/cards/74677422.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/74677422.jpg",
  },
  {
    id: 6,
    name: "Polymerization",
    type: "Spell",
    frameType: "spell",
    effectText:
      "Fusion Summon 1 Fusion Monster from your Extra Deck, using monsters from your hand or field as Fusion Material.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/24094653.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/24094653.jpg",
  },
  {
    id: 7,
    name: "Solemn Judgment",
    type: "Trap",
    frameType: "trap",
    effectText:
      "When a monster would be Summoned, OR a Spell/Trap Card is activated: Pay half your LP; negate the Summon or activation, and if you do, destroy that card.",
    imageUrl: "https://images.ygoprodeck.com/images/cards/41420027.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/41420027.jpg",
  },
  {
    id: 8,
    name: "Summoned Skull",
    type: "Fiend Monster",
    frameType: "normal",
    attribute: "DARK",
    level: 6,
    effectText:
      "A fiend with dark powers for confusing the enemy. Among the Fiend-Type monsters, this monster boasts considerable force.",
    atk: 2500,
    def: 1200,
    imageUrl: "https://images.ygoprodeck.com/images/cards/70781052.jpg",
    imageUrlSmall: "https://images.ygoprodeck.com/images/cards_small/70781052.jpg",
  },
];

const MOCK_SEATS = [
  {
    seatIndex: 0,
    playerId: 1,
    displayName: "Yugi",
    hasPicked: false,
    isCurrentPlayer: true,
  },
  {
    seatIndex: 1,
    playerId: 2,
    displayName: "Kaiba",
    hasPicked: false,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 2,
    playerId: 3,
    displayName: "Joey",
    hasPicked: true,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 3,
    playerId: 4,
    displayName: "Tea",
    hasPicked: false,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 4,
    playerId: 5,
    displayName: "Tristan",
    hasPicked: false,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 5,
    playerId: 6,
    displayName: "Mai",
    hasPicked: true,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 6,
    playerId: 7,
    displayName: "Weevil",
    hasPicked: false,
    isCurrentPlayer: false,
  },
  {
    seatIndex: 7,
    playerId: 8,
    displayName: "Rex",
    hasPicked: false,
    isCurrentPlayer: false,
  },
];

export default function DraftRoomPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";

  const setFromServer = useDraftStore((s) => s.setFromServer);
  useDraftWebsocket(slug);

  // Initialize with mock data for UI development
  useEffect(() => {
    setFromServer({
      slug,
      packRound: 1,
      pickStep: 1,
      currentPack: MOCK_CARDS,
      myPool: [MOCK_CARDS[2]],
      seats: MOCK_SEATS,
      timerSeconds: 45,
      isMyTurn: true,
      completed: false,
      pickSeconds: 60,
    });
  }, [slug, setFromServer]);

  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      {/* Mobile sticky timer */}
      <div className="sticky top-0 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3 sm:hidden">
        <TimerBar />
      </div>

      <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
        {/* Mobile: seats between timer and cards */}
        <div className="mb-6 sm:hidden">
          <SeatList />
        </div>

        {/*
          Layout:
          - Mobile (<640px): single column, sticky timer, seats, cards, pool bottom sheet
          - Tablet (640-1024px): two columns — cards left, sidebar (timer+seats+pool) right
          - Desktop (>1024px): three columns — timer+seats left, cards center, pool right
        */}
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8 lg:gap-8">
          {/* Desktop left panel: Timer + Seats */}
          <aside className="hidden w-64 shrink-0 flex-col gap-4 lg:flex">
            <TimerBar />
            <SeatList />
          </aside>

          {/* Center: Cards (primary content, always flex-1) */}
          <section className="min-w-0 flex-1">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="font-display text-xl text-text-primary sm:text-2xl">
                Current Pack
              </h1>
              <span className="text-sm text-text-secondary">
                {MOCK_CARDS.length} cards
              </span>
            </div>
            <CardGrid />
          </section>

          {/* Tablet right panel: Timer + Seats + Pool */}
          <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex sm:w-64 lg:hidden">
            <TimerBar />
            <SeatList />
            <PoolPanel />
          </aside>

          {/* Desktop right panel: Pool only */}
          <aside className="hidden w-64 shrink-0 lg:block">
            <PoolPanel />
          </aside>
        </div>

        {/* Mobile pool bottom sheet */}
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-deep/95 backdrop-blur-sm p-4 sm:hidden">
          <PoolPanel />
        </div>

        {/* Mobile bottom padding to account for sticky pool */}
        <div className="h-20 sm:hidden" />
      </div>
    </main>
  );
}
