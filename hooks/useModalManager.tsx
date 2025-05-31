import { useState, useCallback } from "react";

/**
 * @type ModalData
 * The type of the data passed to the modal.
 */
type ModalData<T> = T | undefined;

/**
 * @type UseModalManagerReturn
 * The return type of the useModalManager hook.
 */
type UseModalManagerReturn<T> = {
  isOpen: boolean;
  modalData: ModalData<T>;
  openModal: (data?: T) => void;
  closeModal: () => void;
};

/**
 * A hook to manage modals.
 * @returns An object with the modal state and functions to open and close the modal.
 */
export default function useModalManager<T = undefined>(): UseModalManagerReturn<T> {
  const [isOpen, setIsOpen] = useState(false);
  const [modalData, setModalData] = useState<ModalData<T>>(undefined);

  const openModal = useCallback((data?: T) => {
    setModalData(data);
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    // Optionally reset modalData to undefined when closing,
    // or let it persist until the next openModal call if preferred.
    // For this use case, resetting seems cleaner.
    setModalData(undefined);
  }, []);

  return {
    isOpen,
    modalData,
    openModal,
    closeModal
  };
}
