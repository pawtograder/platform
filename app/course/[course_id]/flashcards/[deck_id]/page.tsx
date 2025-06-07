"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { Container, Heading, HStack, VStack, Text, Spinner, Progress, Card } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { FaArrowLeft, FaRedo, FaCheckCircle } from "react-icons/fa";
import useAuthState from "@/hooks/useAuthState";
import { useList, useOne } from "@refinedev/core";
import { Database } from "@/utils/supabase/SupabaseTypes";
import Link from "@/components/ui/link";
import { Toaster, toaster } from "@/components/ui/toaster";
import { Alert } from "@/components/ui/alert";
import { createClient } from "@/utils/supabase/client";
import Flashcard from "./flashcard";
import GotItPile from "./gotItPile";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
type StudentFlashcardProgressRow = Database["public"]["Tables"]["student_flashcard_deck_progress"]["Row"];

/**
 * Page component for students to practice flashcards.
 * Includes comprehensive interaction logging for analytics and persistent progress tracking.
 * @returns A React component that displays the flashcard deck and allows the user to practice the flashcards.
 */
export default function FlashcardsDeckPage() {
  const params = useParams();
  const { user } = useAuthState();
  const supabase = createClient();

  const courseId = params.course_id as string;
  const deckId = params.deck_id as string;

  // Convert to numbers for database operations
  const courseIdNum = Number(courseId);
  const deckIdNum = Number(deckId);

  // State management
  const [currentCardIndex, setCurrentCardIndex] = useState<number>(0);
  const [showAnswer, setShowAnswer] = useState<boolean>(false);
  const [promptViewTimestamp, setPromptViewTimestamp] = useState<number>(0);
  const [answerViewTimestamp, setAnswerViewTimestamp] = useState<number>(0);
  const [gotItCardIds, setGotItCardIds] = useState<Set<number>>(new Set());
  const [sessionStarted, setSessionStarted] = useState<boolean>(false);
  const [progressLoaded, setProgressLoaded] = useState<boolean>(false);
  const [cardQueue, setCardQueue] = useState<FlashcardRow[]>([]);

  // Fetch deck data
  const {
    data: deckData,
    isLoading: isDeckLoading,
    error: deckError
  } = useOne<FlashcardDeckRow>({
    resource: "flashcard_decks",
    id: deckId,
    queryOptions: {
      enabled: !!deckId
    }
  });

  // Fetch flashcards for this deck
  const {
    data: flashcardsData,
    isLoading: isFlashcardsLoading,
    error: flashcardsError
  } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [
      {
        field: "deck_id",
        operator: "eq",
        value: deckIdNum
      },
      {
        field: "deleted_at",
        operator: "null",
        value: null
      }
    ],
    queryOptions: {
      enabled: !!deckId
    }
  });

  // Fetch student's progress for this deck
  const {
    data: progressData,
    isLoading: isProgressLoading,
    refetch: refetchProgress
  } = useList<StudentFlashcardProgressRow>({
    resource: "student_flashcard_deck_progress",
    filters: [
      {
        field: "student_id",
        operator: "eq",
        value: user?.id || ""
      },
      {
        field: "class_id",
        operator: "eq",
        value: courseIdNum
      },
      {
        field: "is_mastered",
        operator: "eq",
        value: true
      }
    ],
    queryOptions: {
      enabled: !!user?.id && !isNaN(courseIdNum)
    }
  });

  const deck = deckData?.data;
  const flashcards = useMemo(() => flashcardsData?.data || [], [flashcardsData?.data]);
  const masteredCardIds = useMemo(() => {
    return new Set((progressData?.data || []).map((progress) => progress.card_id));
  }, [progressData?.data]);

  // Update local state when progress data changes
  useEffect(() => {
    if (!isProgressLoading && progressData?.data) {
      setGotItCardIds(masteredCardIds);
      setProgressLoaded(true);
    }
  }, [isProgressLoading, progressData?.data, masteredCardIds]);

  // Create shuffled array of available cards, excluding those in "got it" pile (Fisher-Yates shuffle)
  const availableCards = useMemo(() => {
    const available = flashcards.filter((card) => !gotItCardIds.has(card.id));
    // Shuffle the array for random order
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }, [flashcards, gotItCardIds]);

  // Update card queue when available cards change
  useEffect(() => {
    setCardQueue(availableCards);
    setCurrentCardIndex((prevIndex) => {
      // If the index is now out of bounds (which can happen when the last card is moved), reset to the first card.
      if (prevIndex >= availableCards.length) {
        return 0;
      }
      return prevIndex;
    });
  }, [availableCards]);

  const gotItCards = useMemo(() => {
    return flashcards.filter((card) => gotItCardIds.has(card.id));
  }, [flashcards, gotItCardIds]);

  const currentCard = cardQueue[currentCardIndex] || null;

  // Display a new card and log the prompt view
  const displayCard = useCallback(
    (cardIndex: number, queue: FlashcardRow[]) => {
      const card = queue[cardIndex];
      if (!card || !user?.id) return;

      setCurrentCardIndex(cardIndex);
      setShowAnswer(false);
      setPromptViewTimestamp(Date.now());
      setAnswerViewTimestamp(0); // Reset answer timestamp for new card
      supabase
        .rpc("log_flashcard_interaction", {
          p_action: "card_prompt_viewed",
          p_class_id: courseIdNum,
          p_deck_id: deckIdNum,
          p_student_id: user.id,
          p_card_id: card.id,
          p_duration_on_card_ms: 0
        })
        .then(({ error }) => {
          if (error) {
            toaster.error({
              title: "Failed to log flashcard interaction",
              description: "Error: " + error.message
            });
          }
        });
    },
    [user?.id, courseIdNum, deckIdNum, supabase]
  );

  // Log deck viewed when session starts
  useEffect(() => {
    if (user?.id && !sessionStarted && !isNaN(courseIdNum) && !isNaN(deckIdNum) && progressLoaded) {
      supabase
        .rpc("log_flashcard_interaction", {
          p_action: "deck_viewed",
          p_class_id: courseIdNum,
          p_deck_id: deckIdNum,
          p_student_id: user.id,
          p_duration_on_card_ms: 0
        })
        .then(({ error }) => {
          if (error) {
            toaster.error({
              title: "Failed to log flashcard interaction",
              description: "Error: " + error.message
            });
          }
        });
      setSessionStarted(true);
    }
  }, [user?.id, sessionStarted, courseIdNum, deckIdNum, progressLoaded, supabase]);

  // Initialize with first card when cards are loaded and properly set up timing
  useEffect(() => {
    if (!sessionStarted || cardQueue.length === 0) return;

    // If we have cards and current index is out of bounds, reset to 0
    if (currentCardIndex >= cardQueue.length) {
      displayCard(0, cardQueue);
    } else if (promptViewTimestamp === 0 && cardQueue[currentCardIndex]) {
      // If we have a current card but no timestamp set, initialize it properly
      displayCard(currentCardIndex, cardQueue);
    }
  }, [cardQueue, sessionStarted, currentCardIndex, promptViewTimestamp, displayCard]);

  // Handle showing the answer
  const handleShowAnswer = useCallback(() => {
    if (!currentCard || !user?.id) return;

    // Only calculate duration if we have a valid timestamp (not 0)
    const duration = promptViewTimestamp > 0 ? Date.now() - promptViewTimestamp : 0;
    const now = Date.now();
    supabase
      .rpc("log_flashcard_interaction", {
        p_action: "card_answer_viewed",
        p_class_id: courseIdNum,
        p_deck_id: deckIdNum,
        p_student_id: user.id,
        p_card_id: currentCard.id,
        p_duration_on_card_ms: duration
      })
      .then(({ error }) => {
        if (error) {
          toaster.error({
            title: "Failed to log flashcard interaction",
            description: "Error: " + error.message
          });
        }
      });
    setShowAnswer(true);
    setAnswerViewTimestamp(now); // Track when answer was shown
  }, [currentCard, user?.id, promptViewTimestamp, courseIdNum, deckIdNum, supabase]);

  // Handle "Got It" action
  const handleGotIt = useCallback(async () => {
    if (!currentCard || !user?.id) return;

    // Calculate duration since answer was shown (or prompt if answer not shown yet)
    const duration =
      answerViewTimestamp > 0
        ? Date.now() - answerViewTimestamp
        : promptViewTimestamp > 0
          ? Date.now() - promptViewTimestamp
          : 0;
    supabase
      .rpc("log_flashcard_interaction", {
        p_action: "card_marked_got_it",
        p_class_id: courseIdNum,
        p_deck_id: deckIdNum,
        p_student_id: user.id,
        p_card_id: currentCard.id,
        p_duration_on_card_ms: duration
      })
      .then(({ error }) => {
        if (error) {
          toaster.error({
            title: "Failed to log flashcard interaction",
            description: "Error: " + error.message
          });
        }
      });

    // Update database progress using database function
    const { error } = await supabase.rpc("update_card_progress", {
      p_class_id: courseIdNum,
      p_student_id: user.id,
      p_card_id: currentCard.id,
      p_is_mastered: true
    });

    if (error) {
      toaster.error({
        title: "Failed to save progress",
        description: "Error: " + error.message
      });
      return;
    }

    // Add card to "got it" pile locally
    setGotItCardIds((prev) => new Set([...prev, currentCard.id]));

    // Remove the card from the queue and display the next one
    const newQueue = cardQueue.filter((card) => card.id !== currentCard.id);
    setCardQueue(newQueue);

    if (newQueue.length > 0) {
      const nextIndex = currentCardIndex >= newQueue.length ? 0 : currentCardIndex;
      displayCard(nextIndex, newQueue);
    } else {
      setShowAnswer(false);
      setPromptViewTimestamp(0);
    }

    // Refetch progress to keep data in sync
    refetchProgress();
  }, [
    currentCard,
    user?.id,
    promptViewTimestamp,
    answerViewTimestamp,
    courseIdNum,
    deckIdNum,
    currentCardIndex,
    refetchProgress,
    supabase,
    cardQueue,
    displayCard
  ]);

  // Handle "Keep Trying" action - move current card to back of queue
  const handleKeepTrying = useCallback(() => {
    if (!currentCard || !user?.id) {
      return;
    }

    // Calculate duration since answer was shown (or prompt if answer not shown yet)
    const duration =
      answerViewTimestamp > 0
        ? Date.now() - answerViewTimestamp
        : promptViewTimestamp > 0
          ? Date.now() - promptViewTimestamp
          : 0;
    supabase
      .rpc("log_flashcard_interaction", {
        p_action: "card_marked_keep_trying",
        p_class_id: courseIdNum,
        p_deck_id: deckIdNum,
        p_student_id: user.id,
        p_card_id: currentCard.id,
        p_duration_on_card_ms: duration
      })
      .then(({ error }) => {
        if (error) {
          toaster.error({
            title: "Failed to log flashcard interaction",
            description: "Error: " + error.message
          });
        }
      });

    if (cardQueue.length <= 1) {
      // Even if only one card, flip it back to the question side
      if (cardQueue.length === 1) {
        setShowAnswer(false);
      }
      toaster.create({
        title: "No more cards to move",
        description: "This is the last card in the pile.",
        type: "info"
      });
      return;
    }

    // Move current card to the back of the queue and display the next card
    const newQueue = [...cardQueue];
    const movedCard = newQueue.splice(currentCardIndex, 1)[0];
    newQueue.push(movedCard);
    setCardQueue(newQueue);

    // The next card to show is at the same index, unless we were at the end of the queue, in which case we wrap around.
    const nextIndex = currentCardIndex === newQueue.length - 1 ? 0 : currentCardIndex;
    displayCard(nextIndex, newQueue);
  }, [
    currentCard,
    user?.id,
    promptViewTimestamp,
    answerViewTimestamp,
    courseIdNum,
    deckIdNum,
    currentCardIndex,
    cardQueue,
    displayCard,
    supabase
  ]);

  // Handle returning a card from "got it" pile to practice pile
  const handleReturnCard = useCallback(
    async (cardId: number) => {
      if (!user?.id) return;

      supabase
        .rpc("log_flashcard_interaction", {
          p_action: "card_returned_to_deck",
          p_class_id: courseIdNum,
          p_deck_id: deckIdNum,
          p_student_id: user.id,
          p_card_id: cardId,
          p_duration_on_card_ms: 0
        })
        .then(({ error }) => {
          if (error) {
            toaster.error({
              title: "Failed to log flashcard interaction",
              description: "Error: " + error.message
            });
          }
        });

      // Update database progress using server action
      const { error } = await supabase.rpc("update_card_progress", {
        p_class_id: courseIdNum,
        p_student_id: user.id,
        p_card_id: cardId,
        p_is_mastered: false
      });

      if (error) {
        toaster.error({
          title: "Failed to update card progress",
          description: "Error: " + error.message
        });
        return;
      }

      // Remove from "got it" pile locally
      setGotItCardIds((prev) => {
        const updated = new Set(prev);
        updated.delete(cardId);
        return updated;
      });

      // Refetch progress to keep data in sync
      refetchProgress();
    },
    [user?.id, courseIdNum, deckIdNum, refetchProgress, supabase]
  );

  // Handle resetting all progress
  const handleResetAllProgress = useCallback(async () => {
    if (!user?.id) return;

    supabase
      .rpc("log_flashcard_interaction", {
        p_action: "deck_progress_reset_all",
        p_class_id: courseIdNum,
        p_deck_id: deckIdNum,
        p_student_id: user.id,
        p_duration_on_card_ms: 0
      })
      .then(({ error }) => {
        if (error) {
          toaster.error({
            title: "Failed to log flashcard interaction",
            description: "Error: " + error.message
          });
        }
      });

    // Reset database progress using server action
    const cardIds = flashcards.map((card) => card.id);
    const { error } = await supabase.rpc("reset_all_flashcard_progress", {
      p_class_id: courseIdNum,
      p_student_id: user.id,
      p_card_ids: cardIds
    });

    if (error) {
      toaster.error({
        title: "Failed to reset progress",
        description: "Error: " + error.message
      });
      return;
    }

    // Reset local state
    setGotItCardIds(new Set());
    setCurrentCardIndex(0);
    setShowAnswer(false);

    // Refetch progress to keep data in sync
    refetchProgress();

    toaster.create({
      title: "Progress Reset",
      description: "All cards have been returned to the practice pile.",
      type: "info"
    });
  }, [user?.id, courseIdNum, deckIdNum, flashcards, refetchProgress, supabase]);

  // Loading states
  if (isDeckLoading || isFlashcardsLoading || isProgressLoading || !progressLoaded) {
    return (
      <Container mt={2}>
        <VStack align="center" justify="center" minH="400px" gap={4}>
          <Spinner size="lg" />
          <Text>Loading flashcard deck...</Text>
        </VStack>
      </Container>
    );
  }

  // Error states
  if (deckError || flashcardsError) {
    return (
      <Container mt={2}>
        <Alert status="error" title="Error Loading Deck">
          Failed to load the flashcard deck. Please try again later.
        </Alert>
      </Container>
    );
  }

  // No deck found
  if (!deck) {
    return (
      <Container mt={2}>
        <Alert status="warning" title="Deck Not Found">
          The requested flashcard deck could not be found.
        </Alert>
      </Container>
    );
  }

  const backToDecks = (
    <HStack>
      <Link href={`/course/${courseId}/flashcards`}>
        <Button variant="outline" size="sm">
          <FaArrowLeft />
          Back to Decks
        </Button>
      </Link>
    </HStack>
  );

  // No cards in deck
  if (flashcards.length === 0) {
    return (
      <Container mt={2}>
        <VStack align="stretch" gap={6}>
          {backToDecks}
          <Heading size="lg">{deck.name}</Heading>

          <Alert status="info" title="No Cards Available">
            This flashcard deck doesn&apos;t have any cards yet. Check back later when your instructor adds some cards.
          </Alert>
        </VStack>
      </Container>
    );
  }

  // All cards completed
  if (cardQueue.length === 0) {
    return (
      <Container mt={2}>
        <VStack align="stretch" gap={6}>
          {backToDecks}

          <Heading size="lg">{deck.name}</Heading>

          <Card.Root>
            <Card.Body>
              <VStack align="center" gap={4} p={8}>
                <FaCheckCircle size={48} color="green" />
                <Heading size="md">Great job! 🎉</Heading>
                <Text textAlign="center">
                  You&apos;ve completed all cards in this deck! You got {gotItCards.length} out of {flashcards.length}{" "}
                  cards right.
                </Text>
                <Button onClick={handleResetAllProgress}>
                  <FaRedo />
                  Start Over
                </Button>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Show "Got It" cards for review */}
          <GotItPile gotItCards={gotItCards} onReturnCard={handleReturnCard} />
        </VStack>
      </Container>
    );
  }

  // Normal practice view
  return (
    <Container mt={2}>
      <VStack align="stretch" gap={6}>
        {/* Header */}
        <HStack justifyContent="space-between" alignItems="center">
          {backToDecks}
          <Heading size="lg" textAlign="center" flex={1}>
            {deck.name}
          </Heading>
          <HStack>
            <Button onClick={handleResetAllProgress} variant="outline" size="sm">
              <FaRedo />
              Reset Progress
            </Button>
          </HStack>
        </HStack>

        {/* Progress bar */}
        <VStack align="stretch" gap={2}>
          <HStack justifyContent="space-between">
            <Text fontSize="sm">
              Progress: {gotItCards.length} / {flashcards.length} cards mastered
            </Text>
            <Text fontSize="sm">Remaining: {cardQueue.length}</Text>
          </HStack>
          <Progress.Root value={(gotItCards.length / flashcards.length) * 100} size="lg" colorPalette="green">
            <Progress.Track>
              <Progress.Range />
            </Progress.Track>
          </Progress.Root>
        </VStack>

        {/* Current flashcard */}
        {currentCard && (
          <Flashcard
            currentCard={currentCard}
            availableCards={cardQueue}
            showAnswer={showAnswer}
            onShowAnswer={handleShowAnswer}
            onGotIt={handleGotIt}
            onKeepTrying={handleKeepTrying}
          />
        )}

        {/* "Got It" pile summary */}
        <GotItPile gotItCards={gotItCards} onReturnCard={handleReturnCard} />
      </VStack>
      <Toaster />
    </Container>
  );
}
