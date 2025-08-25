import styled from "styled-components";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StyledChat = styled.aside<any>`
  display: grid;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "chat-header"
    "messages"
    "chat-input";
  width: 100%;
  height: 100%;
  padding-bottom: 1rem;
  overflow-y: auto;
  background-color: ${(props) => props.theme.chat.bgd};
  box-shadow: 1rem 1rem 3.75rem 0 rgba(0, 0, 0, 0.1);
  border-top: 0.0625rem solid ${(props) => props.theme.chat.containerBorder};
  border-left: 0.0625rem solid ${(props) => props.theme.chat.containerBorder};
  border-right: 0.0625rem solid ${(props) => props.theme.chat.containerBorder};

  &[data-visual-test-no-radius] {
    border-radius: 0 !important;
  }

  ${({ theme }) => theme.mediaQueries.min.md} {
    width: ${(props) => props.theme.chat.maxWidth};
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const StyledTitle = styled.div<any>`
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: ${(props) => props.theme.colors.fontPrimary};
  margin-bottom: 1rem;
  padding: 1rem 1rem 0.5rem 1rem;
  border-bottom: 0.0625rem solid ${(props) => props.theme.colors.borderControl};
  display: flex;
  align-items: center;
  justify-content: space-between;

  &[data-visual-test-no-radius] {
    border-radius: 0 !important;
  }
`;

export const StyledChatInputContainer = styled.div`
  grid-area: chat-input;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 0.75rem;

  .ch-input-wrapper {
    width: 90%;

    .ch-input {
      width: 100%;
    }
  }
`;

export const StyledMessages = styled.div`
  grid-area: messages;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  row-gap: 0.5rem;
`;
