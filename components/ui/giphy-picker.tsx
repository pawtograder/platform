"use client";
import React, { useContext } from "react";
import type { IGif } from "@giphy/js-types";
import { Grid, SearchBar, SearchContext, SearchContextManager, SuggestionBar } from "@giphy/react-components";
import { VStack, Container } from "@chakra-ui/react";

const GiphyPicker = ({ onGifSelect }: { onGifSelect: (gif: IGif) => void }) => (
  <SearchContextManager apiKey="yVBc6zuQtPlYItUXdgBTPXP1NYx1P3vW">
    <InnerPicker onGifSelect={onGifSelect} />
  </SearchContextManager>
);

const InnerPicker = ({ onGifSelect }: { onGifSelect: (gif: IGif) => void }) => {
  const { fetchGifs, searchKey } = useContext(SearchContext);

  return (
    <Container overflowY="auto" height="300px" width="400px">
      <VStack align="stretch" spaceY={2}>
        <SearchBar />
        <SuggestionBar />
        {/**
                key will recreate the component,
                this is important for when you change fetchGifs
                e.g. changing from search term dogs to cats or type gifs to stickers
                you want to restart the gifs from the beginning and changing a component's key does that
            **/}
        <Grid
          key={searchKey}
          columns={3}
          width={300}
          fetchGifs={fetchGifs}
          onGifClick={(gif, e) => {
            e.preventDefault();
            onGifSelect(gif);
          }}
        />
      </VStack>
    </Container>
  );
};

export default GiphyPicker;
