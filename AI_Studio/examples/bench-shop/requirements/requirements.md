# BenchShop requirements

This document describes how BenchShop is intended to behave. It is the product owner's statement of the expected behaviour, written
for the people who build and test the shop: where the application behaves differently, the application is wrong, not this document.
Each requirement is one numbered line; the numbers are stable.

## 1. Visitors, accounts and signing in

- 1.1 Anyone can browse the product list and every product page without signing in.
- 1.2 The cart, checkout, orders and account pages are for signed-in customers; a visitor who opens one is taken to the sign-in page and, after signing in, back to the page they asked for.
- 1.3 The main navigation shows Products and Cart to everyone, Orders, Account and Sign out to signed-in customers, and Sign in and Create account to visitors.
- 1.4 Anyone can create an account with a name, an email address and a password.
- 1.5 The name is required; an empty name is refused with "Enter your name."
- 1.6 The email address must be a valid email address; anything else is refused with "Enter a valid email address."
- 1.7 The password must have at least 8 characters; a shorter one is refused with a message that states the minimum.
- 1.8 An email address can belong to one account only; registering again with it is refused (API: 409).
- 1.9 Email addresses are not case-sensitive and spaces around them are ignored, when registering and when signing in.
- 1.10 A new account is signed in straight away and has no default delivery address yet.
- 1.11 A customer signs in with their email address and password; a wrong combination is refused with "Email or password is wrong." (API: 401).
- 1.12 Signing out ends the session; the person is then a visitor again.

## 2. Products

- 2.1 The shop sells five products: Trail Mug, Desk Lamp, Pocket Notebook, Headphones and Water Bottle.
- 2.2 The product list shows each product's name and price and states that shipping is free on orders of $50.00 or more.
- 2.3 A product page shows the product's name, price and description and says how many of it one customer may order.
- 2.4 A signed-in customer can add the product to the cart from its page, choosing a quantity (1 unless changed).
- 2.5 A visitor on a product page is invited to sign in to buy.
- 2.6 A product that does not exist shows "Product not found" (page and API: 404).
- 2.7 Prices are shown in dollars with two decimals; the API gives every amount in cents.

## 3. Cart

- 3.1 Each customer has one cart; it starts empty, and an empty cart says so and links back to the products.
- 3.2 Adding a product that is not in the cart yet creates a cart line with the chosen quantity.
- 3.3 Adding a product that is already in the cart increases that line's quantity by the quantity added.
- 3.4 Only products of the shop can be added; adding a product that does not exist is refused with "Product not found." (API: 404) and leaves the cart unchanged.
- 3.5 A quantity must be a whole number of at least 1; anything else is refused with "Choose a quantity of at least 1."
- 3.6 A customer can have at most 10 of each item in the cart; a change that would make an item's quantity more than 10 is refused with "You can order up to 10 of each item." and the cart stays as it was.
- 3.7 On the cart page the customer can change the quantity of a line, within the limits above, and remove a line.
- 3.8 Each cart line shows the item, its unit price, the quantity and the line total; the line total is the unit price times the quantity.
- 3.9 The cart's subtotal is the sum of its line totals.
- 3.10 The cart shows the subtotal, the discount, the shipping charge and the total; the total is the subtotal minus the discount plus the shipping charge.
- 3.11 The discount code form and the Check out button appear only when the cart has at least one line.

## 4. Discounts and shipping

- 4.1 The shop has one discount code, SAVE10, which takes 10% off the order subtotal, rounded to the nearest cent.
- 4.2 Codes are accepted in any letter case and with spaces around them; an unknown code is refused with "That code is not valid." (API: 400).
- 4.3 An applied code stays on the cart, and its name is shown next to the discount.
- 4.4 Shipping costs $5.00 per order.
- 4.5 Shipping is free when the subtotal after the discount is $50.00 or more.
- 4.6 An empty cart has no shipping charge.

## 5. Checkout

- 5.1 Checkout has two steps, in this order: 1. Delivery address, 2. Review and pay.
- 5.2 Step 1 starts with the customer's default delivery address, which can be changed for this checkout only.
- 5.3 A delivery address needs at least 5 characters; a shorter one is refused with "Enter a delivery address."
- 5.4 Step 2 is reached through step 1: a customer who opens the review step before giving a delivery address in the current checkout is sent to step 1.
- 5.5 An order needs a delivery address given in step 1 of the current checkout; placing an order without one is refused with "Add a delivery address first." (API: 409).
- 5.6 The review step shows the delivery address, the cart with its prices, and a Place order button.
- 5.7 Placing an order with an empty cart is refused with "Your cart is empty." (API: 409).
- 5.8 Placing an order turns the cart into the order: afterwards the cart is empty and the next checkout starts again at step 1.
- 5.9 An order keeps a copy of the cart's lines, subtotal, discount, shipping charge and total, the delivery address and the time it was placed, and gets a number of the form ord-NNNN.
- 5.10 After placing an order the customer sees the new order's page.

## 6. Orders

- 6.1 An order is Placed, Paid, Shipped or Cancelled; a new order is Placed.
- 6.2 Orders are shipped by the warehouse, outside this application.
- 6.3 The Orders page lists all of the customer's orders, newest first, each with its number, date, status and total.
- 6.4 A customer without orders sees "No orders yet."
- 6.5 An order page shows the order's status, lines, total and delivery address.
- 6.6 Customers can see only their own orders; any other order number shows "Order not found" (page and API: 404).
- 6.7 Only a Placed order can be paid; paying makes it Paid, and paying an order in any other state is refused (API: 409).
- 6.8 A customer can cancel an order until it ships: cancelling makes it Cancelled, and a Shipped order cannot be cancelled (API: 409).
- 6.9 A Cancelled order cannot be cancelled again (API: 409).
- 6.10 The order page offers Pay now for a Placed order and Cancel order for any order that is not Cancelled; the rules above decide whether the action succeeds.

## 7. Account

- 7.1 The Account page shows the email address the customer signs in with; the email address cannot be changed.
- 7.2 On the Account page the customer can change their name and default delivery address and save them; the name is required.
- 7.3 Saving shows "Saved."; the saved name and address are the account's from then on, wherever the account's details are shown or used, including the starting address of the next checkout.

## 8. API

- 8.1 The JSON API is described at /openapi.json, and every operation answers with the status codes described there.
- 8.2 API operations other than listing products, reading a product, registering, signing in and signing out answer 401 with "Sign in first." to a visitor.
- 8.3 API errors are JSON objects with an error message that can be shown to the customer.
- 8.4 Request bodies larger than 64 KB are ignored.
