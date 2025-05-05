import { useAudioVideo } from "amazon-chime-sdk-component-library-react";
import { DataMessage } from "amazon-chime-sdk-js";
import React, {
  useEffect,
  useReducer,
  createContext,
  useContext,
  FC,
  useCallback,
  PropsWithChildren,
  useMemo
} from "react";
import { DATA_MESSAGE_LIFETIME_MS, DATA_MESSAGE_TOPIC } from "../../constants";
import { useAppState } from "../AppStateProvider";

interface State {
  messages: DataMessage[];
}

type Action = { type: "append"; payload: DataMessage } | { type: "filter" };

const initialState: State = {
  messages: []
};

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "append":
      // Check if message already exists based on text and timestamp
      const exists = state.messages.some(
        (msg) => msg.text() === action.payload.text() && msg.timestampMs === action.payload.timestampMs
      );
      if (exists) {
        return state; // Return current state if message is a duplicate
      }
      return { ...state, messages: [...state.messages, action.payload] };
    case "filter":
      const now = Date.now();
      return {
        ...state,
        messages: state.messages.filter((msg) => now - msg.timestampMs! < DATA_MESSAGE_LIFETIME_MS)
      };
    default:
      return state;
  }
};

interface DataMessagesContextType {
  messages: DataMessage[];
  sendMessage: (message: string) => void;
}

export const DataMessagesStateContext = createContext<DataMessagesContextType | null>(null);

export const DataMessagesProvider: FC<PropsWithChildren> = ({ children }) => {
  const { localUserName } = useAppState();
  const audioVideo = useAudioVideo();
  const [state, dispatch] = useReducer(reducer, initialState);

  // <<< handler definition START >>>
  const handler = useCallback(
    (dataMessage: DataMessage) => {
      if (!dataMessage.timestampMs || !dataMessage.text()) {
        return;
      }
      dispatch({ type: "append", payload: dataMessage });
    },
    [dispatch]
  );
  // <<< handler definition END >>>

  // <<< useEffect hook START >>>
  useEffect(() => {
    if (!audioVideo) {
      return;
    }
    audioVideo.realtimeSubscribeToReceiveDataMessage(DATA_MESSAGE_TOPIC, handler);
    return () => {
      audioVideo.realtimeUnsubscribeFromReceiveDataMessage(DATA_MESSAGE_TOPIC);
    };
  }, [audioVideo, handler]);
  // <<< useEffect hook END >>>

  const sendMessage = useCallback(
    (message: string) => {
      audioVideo?.realtimeSendDataMessage(
        DATA_MESSAGE_TOPIC,
        JSON.stringify({ senderName: localUserName, msg: message }),
        DATA_MESSAGE_LIFETIME_MS
      );
    },
    [audioVideo, localUserName]
  );

  // Filter messages periodically
  useEffect(() => {
    const intervalId = setInterval(() => {
      dispatch({ type: "filter" });
    }, 60000); // filter every minute
    return () => clearInterval(intervalId);
  }, [dispatch]);

  const value = useMemo(() => ({ sendMessage, messages: state.messages }), [sendMessage, state.messages]);

  return <DataMessagesStateContext.Provider value={value}>{children}</DataMessagesStateContext.Provider>;
};

export function useDataMessagesState(): DataMessagesContextType {
  const state = useContext(DataMessagesStateContext);

  if (!state) {
    throw new Error("useDataMessagesState must be used within DataMessagesProvider");
  }

  return state;
}
