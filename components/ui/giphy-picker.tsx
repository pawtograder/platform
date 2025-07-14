"use client";
import { Container, Image, VStack } from "@chakra-ui/react";
import { IGif } from "@giphy/js-types";
import { Grid, SearchBar, SearchContext, SearchContextManager } from "@giphy/react-components";
import { useContext } from "react";
import { useColorMode } from "./color-mode";

const GiphyPicker = ({ onGifSelect }: { onGifSelect: (gif: IGif) => void }) => (
  <SearchContextManager apiKey="yVBc6zuQtPlYItUXdgBTPXP1NYx1P3vW">
    <InnerPicker onGifSelect={onGifSelect} />
  </SearchContextManager>
);

const InnerPicker = ({ onGifSelect }: { onGifSelect: (gif: IGif) => void }) => {
  const { fetchGifs, searchKey } = useContext(SearchContext);

  const { colorMode } = useColorMode();

  return (
    <Container overflowY="auto" height="300px" width="400px">
      <VStack align="stretch" spaceY={2}>
        <SearchBar />
        <Image w="200px" src={colorMode === "dark" ? "/giphy_black.png" : "/giphy_white.png"} alt="Powered by Giphy" />
        {/* <SuggestionBar /> */}
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
