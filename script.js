/* =========================================================
   Bokka Bageri — script.js
   Vanilla JS only. Handles:
   - interest form validation
   - asynchronous submission to Formspree (no page reload)
   - a warm success message
   - gentle scroll-reveal animations
   ========================================================= */

(function () {
  "use strict";

  /* -----------------------------------------------------
     Interest form
     ----------------------------------------------------- */
  const form = document.getElementById("interest-form");
  const successBox = document.getElementById("form-success");
  const successText = document.getElementById("form-success-text");
  const resetBtn = document.getElementById("form-reset");
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  const formError = document.getElementById("form-error");
  const submitBtnLabel = submitBtn ? submitBtn.textContent : "";

  /**
   * Very light contact check: accept either an email-ish string
   * or a phone number with at least 8 digits. We stay forgiving
   * on purpose — this is a low-pressure interest form.
   */
  function isValidContact(value) {
    const trimmed = value.trim();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    const digitCount = (trimmed.match(/\d/g) || []).length;
    const looksLikePhone = digitCount >= 8;
    return looksLikeEmail || looksLikePhone;
  }

  function setError(input, errorEl, show) {
    if (show) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorEl.id);
      errorEl.hidden = false;
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      errorEl.hidden = true;
    }
  }

  if (form) {
    const firstName = form.elements["fornavn"];
    const contact = form.elements["kontakt"];
    const firstNameError = document.getElementById("fornavn-error");
    const contactError = document.getElementById("kontakt-error");

    // Clear an error as soon as the neighbour starts fixing it.
    firstName.addEventListener("input", function () {
      if (firstName.value.trim()) setError(firstName, firstNameError, false);
    });
    contact.addEventListener("input", function () {
      if (isValidContact(contact.value)) setError(contact, contactError, false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      const nameOk = firstName.value.trim().length > 0;
      const contactOk = isValidContact(contact.value);

      setError(firstName, firstNameError, !nameOk);
      setError(contact, contactError, !contactOk);

      if (!nameOk) {
        firstName.focus();
        return;
      }
      if (!contactOk) {
        contact.focus();
        return;
      }

      submitToFormspree();
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        hideFormError();
        setSubmitting(false);
        successBox.hidden = true;
        form.hidden = false;
        firstName.focus();
      });
    }
  }

  /**
   * Send the form to Formspree with fetch so the page never reloads.
   * The success state is shown only after Formspree confirms (HTTP 2xx);
   * a network error or non-OK response shows a friendly notice instead.
   */
  function submitToFormspree() {
    if (!form) return;
    hideFormError();
    setSubmitting(true);

    const name = form.elements["fornavn"].value.trim();

    fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (response.ok) {
          showSuccess(name);
        } else {
          showFormError();
        }
      })
      .catch(function () {
        showFormError();
      })
      .then(function () {
        setSubmitting(false);
      });
  }

  function setSubmitting(isSubmitting) {
    if (!submitBtn) return;
    submitBtn.disabled = isSubmitting;
    if (isSubmitting) {
      form.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sender …";
    } else {
      form.removeAttribute("aria-busy");
      submitBtn.textContent = submitBtnLabel;
    }
  }

  function showFormError() {
    if (formError) formError.hidden = false;
  }

  function hideFormError() {
    if (formError) formError.hidden = true;
  }

  function showSuccess(name) {
    if (!successBox) return;
    if (successText) {
      successText.textContent =
        "Takk, " +
        name +
        "! Vi sier fra neste gang Bokka fyrer opp ovnen. Helt uforpliktende, som lovet.";
    }
    form.hidden = true;
    successBox.hidden = false;
    // Move focus so screen readers announce the result.
    successBox.setAttribute("tabindex", "-1");
    successBox.focus();
    successBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* -----------------------------------------------------
     Gentle scroll-reveal animations
     Respects prefers-reduced-motion via CSS.
     ----------------------------------------------------- */
  const revealTargets = document.querySelectorAll(
    ".product-card, .step, .bobler-card, .bobler__art, .story__inner, .section__head, .interest__card"
  );

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    revealTargets.forEach(function (el) {
      el.classList.add("reveal");
    });

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  }
})();
