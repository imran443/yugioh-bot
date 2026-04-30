export type DraftImageCard = {
  ygoprodeckId: number;
  imageUrl: string;
  imageUrlSmall?: string;
};

export function createDraftImageService(_input: { cacheDir: string }) {
  return {
    async renderNumberedGrid(_cards: DraftImageCard[]) {
      throw new Error("Draft image rendering is not implemented yet");
    },
  };
}

export type DraftImageService = ReturnType<typeof createDraftImageService>;
