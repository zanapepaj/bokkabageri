/* =========================================================
   Bokka Bageri — script.js
   Vanilla JS only. Handles:
   - interest form validation
   - saving demo submissions to localStorage (no backend yet)
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

  const STORAGE_KEY = "bokka-interest-demo";

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

      // Collect the submission.
      const submission = {
        fornavn: firstName.value.trim(),
        kontakt: contact.value.trim(),
        produkter: getChecked(form, "produkter"),
        dager: getChecked(form, "dager"),
        nabolag: (form.elements["nabolag"].value || "").trim(),
        tidspunkt: new Date().toISOString(),
      };

      saveSubmission(submission);

      /* ---------------------------------------------------
         BACKEND HOOK — connect a real backend here later.
         Right now we only store demo data in localStorage.

         When we go live, replace the saveSubmission() call
         above (or add here) with something like:

           fetch("/api/interest", {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify(submission),
           });

         Consider: server-side validation, spam protection,
         GDPR-friendly storage, and a double opt-in confirmation.
         --------------------------------------------------- */

      showSuccess(submission);
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        successBox.hidden = true;
        form.hidden = false;
        firstName.focus();
      });
    }
  }

  function getChecked(formEl, name) {
    return Array.prototype.slice
      .call(formEl.querySelectorAll('input[name="' + name + '"]:checked'))
      .map(function (el) {
        return el.value;
      });
  }

  function saveSubmission(submission) {
    let all = [];
    try {
      all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (err) {
      all = [];
    }
    all.push(submission);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      // localStorage can be unavailable (private mode / full).
      // Failing quietly is fine for this demo.
    }
  }

  function showSuccess(submission) {
    if (!successBox) return;
    if (successText) {
      successText.textContent =
        "Takk, " +
        submission.fornavn +
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
