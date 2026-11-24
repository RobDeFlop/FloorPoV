import { useEffect, useRef, type RefObject } from "react";
import { KeyCode } from "../types/key-code";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface UseModalFocusOptions {
  isOpen: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
}

export function useModalFocus({
  isOpen,
  dialogRef,
  initialFocusRef,
  fallbackFocusRef,
  onEscape,
}: UseModalFocusOptions): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!isOpen || !dialogRef.current) {
      return;
    }

    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modalRoot = dialogRef.current.closest<HTMLElement>("[data-modal-root]");
    const backgroundElements = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element !== modalRoot,
    );
    const previousInertState = backgroundElements.map((element) => ({
      element,
      wasInert: element.hasAttribute("inert"),
    }));

    backgroundElements.forEach((element) => element.setAttribute("inert", ""));
    initialFocusRef?.current?.focus();

    if (!initialFocusRef?.current) {
      dialogRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === KeyCode.Escape) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }

      if (event.key !== KeyCode.Tab || !dialogRef.current) {
        return;
      }

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousInertState.forEach(({ element, wasInert }) => {
        if (!wasInert) {
          element.removeAttribute("inert");
        }
      });
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      } else if (fallbackFocusRef?.current?.isConnected) {
        fallbackFocusRef.current.focus();
      }
    };
  }, [dialogRef, fallbackFocusRef, initialFocusRef, isOpen]);
}
