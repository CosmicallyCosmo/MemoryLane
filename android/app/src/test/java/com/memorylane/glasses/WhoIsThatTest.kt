package com.memorylane.glasses

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Who "who is that ...?" means in a memory with Maya (who added it) and Jake in it. */
class WhoIsThatTest {
  private fun person(id: String, name: String, relationship: String) = Person(id, name, relationship, "", null)

  private val maya = person("maya", "Maya Patel", "Daughter")
  private val jake = person("jake", "Jake", "Son")
  private val ana = person("ana", "Ana", "Friend")
  private val people = listOf(maya, jake, ana)

  private fun meant(said: String) = whoDescription(said)?.let { whoIsMeant(it, people, owner = maya) }

  @Test
  fun justAskingIsThePersonWhoseMemoryItIs() {
    for (said in listOf("who is that", "who's this", "whos that in the picture", "who is it from", "who are you", "who are they")) {
      assertEquals(said, maya, meant(said))
    }
  }

  @Test
  fun moreSaidPicksOutWhoeverAloneFitsIt() {
    assertEquals(jake, meant("who's that boy"))
    assertEquals(jake, meant("who is that, my son"))
    assertEquals(jake, meant("who is he"))
    assertEquals(maya, meant("who's the lady holding the dog"))
    assertEquals(maya, meant("who is that, maya"))
    assertEquals(maya, meant("who is that patel"))
    assertEquals(ana, meant("who's that, my friend"))
    assertEquals(maya, meant("who's that little girl"))
    assertEquals(jake, meant("who is that young man"))
    assertEquals(jake, meant("who's that lad, my boy"))
  }

  @Test
  fun relativesAreKnownByEveryWordForThem() {
    val mum = person("mum", "Rose", "Mum")
    val grandson = person("sam", "Sam", "Great-grandson")
    val wife = person("june", "June", "Wife")
    val family = listOf(mum, grandson, wife)
    fun meant(said: String) = whoIsMeant(said, family, owner = null)
    assertEquals(mum, meant("that, my mother"))
    assertEquals(mum, meant("the old lady"))
    assertEquals(mum, meant("that elderly woman"))
    assertEquals(grandson, meant("that baby"))
    assertEquals(grandson, meant("that, my grandkid"))
    assertEquals(grandson, meant("the little boy"))
    assertEquals(wife, meant("that, my missus"))
    assertEquals(wife, meant("that, my spouse"))
  }

  @Test
  fun everyWordSaidMustFit() {
    // Maya is a daughter: young, so never "the old lady".
    assertNull(meant("who's the old lady"))
    assertNull(meant("who is that tall girl"))
  }

  @Test
  fun notSureWhenNobodyOrSomeoneElseIsMeant() {
    assertNull(meant("who's that in the red hat"))
    assertNull(meant("who's that with jake"))
    assertNull(meant("who's that holding the baby"))
    assertNull(meant("who is that, my grandson"))
  }

  @Test
  fun notSureWhenMoreThanOneFits() {
    val sisters = listOf(maya, person("lily", "Lily", "Daughter"))
    assertNull(whoIsMeant("that girl", sisters, owner = maya))
    assertNull(meant("who's that kid"))
    assertNull(meant("who are the children"))
    assertEquals(maya, whoIsMeant("that", sisters, owner = maya))
  }

  @Test
  fun otherQuestionsBeginningWhoAreLeftForTheFamilysAnswers() {
    assertNull(whoDescription("who is coming on sunday"))
    assertNull(whoDescription("who gave me this"))
    assertNull(whoDescription("who was at the wedding"))
  }
}
