import { create } from "zustand";

export interface DraftCardDetail {
  id: number;
  name: string;
  type: string;
  frameType: string;
  attribute?: string;
  level?: number;
  effectText: string;
  atk?: number;
  def?: number;
  imageUrl: string;
  imageUrlSmall: string;
}

export interface Seat {
  seatIndex: number;
  playerId: number;
  displayName: string;
  hasPicked: boolean;
  isCurrentPlayer: boolean;
}

export interface DraftState {
  slug: string;
  packRound: number;
  pickStep: number;
  currentPack: DraftCardDetail[];
  myPool: DraftCardDetail[];
  seats: Seat[];
  timerSeconds: number;
  isMyTurn: boolean;
  completed: boolean;
  pickSeconds: number;
  selectedCardId: number | null;
  highlightedIndex: number;
}

export interface DraftActions {
  setFromServer: (state: Partial<DraftState>) => void;
  pickCard: (cardId: number) => void;
  tick: () => void;
  setSelectedCard: (cardId: number | null) => void;
  setHighlightedIndex: (index: number) => void;
}

const initialState: DraftState = {
  slug: "",
  packRound: 1,
  pickStep: 1,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: false,
  completed: false,
  pickSeconds: 60,
  selectedCardId: null,
  highlightedIndex: -1,
};

export const useDraftStore = create<DraftState & DraftActions>((set) => ({
  ...initialState,

  setFromServer: (partial) =>
    set((state) => ({
      ...state,
      ...partial,
    })),

  pickCard: (cardId) =>
    set((state) => {
      const card = state.currentPack.find((c) => c.id === cardId);
      if (!card || !state.isMyTurn) return state;

      return {
        ...state,
        currentPack: state.currentPack.filter((c) => c.id !== cardId),
        myPool: [...state.myPool, card],
        isMyTurn: false,
        selectedCardId: null,
        highlightedIndex: -1,
      };
    }),

  tick: () =>
    set((state) => ({
      ...state,
      timerSeconds: Math.max(0, state.timerSeconds - 1),
    })),

  setSelectedCard: (cardId) =>
    set((state) => ({
      ...state,
      selectedCardId: cardId,
    })),

  setHighlightedIndex: (index) =>
    set((state) => ({
      ...state,
      highlightedIndex: index,
    })),
}));
